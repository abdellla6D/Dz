import "dotenv/config";
import express from "express";
import session from "express-session";
import crypto from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === "production";
if (production && !process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required in production");

app.set("trust proxy", production ? 1 : 0);
app.use(express.json({limit:"1mb"}));
app.use(express.static("public"));
app.use(session({
  name:"storypage.sid",
  secret:process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  resave:false,
  saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:"lax",secure:production,maxAge:8*60*60*1000}
}));

app.get("/api/health",(_req,res)=>res.json({
  ok:true,
  geminiConfigured:Boolean(process.env.GEMINI_API_KEY),
  tiktokConfigured:Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET && process.env.TIKTOK_REDIRECT_URI)
}));

app.post("/api/story",async(req,res)=>{
  try{
    const now=Date.now();
    if(req.session.lastStoryRequest && now-req.session.lastStoryRequest<5000)
      return res.status(429).json({error:"انتظر خمس ثوانٍ قبل طلب قصة أخرى."});
    req.session.lastStoryRequest=now;
    if(!process.env.GEMINI_API_KEY) return res.status(503).json({error:"محرك Gemini غير مضبوط على الخادم."});
    const {idea,language="ar",genre="mystery",scenes=5,duration=45}=req.body||{};
    if(typeof idea!=="string"||idea.trim().length<3||idea.length>1500)
      return res.status(400).json({error:"اكتب فكرة من 3 إلى 1500 حرف."});
    const count=Math.max(3,Math.min(8,Number(scenes)||5));
    const langName=({ar:"Arabic",en:"English",fr:"French"})[language]||"Arabic";
    const genreName=({mystery:"mystery",drama:"social drama",fantasy:"fantasy",adventure:"adventure"})[genre]||"adventure";
    const seconds=Math.max(20,Math.min(90,Number(duration)||45));
    const prompt=`Create an original ${genreName} story for a vertical short video in ${langName}.\nIdea: ${idea.trim()}\nTarget duration: about ${seconds} seconds.\nCreate exactly ${count} scenes. Return ONLY valid JSON with this exact structure: {"title":"...","hook":"...","scenes":[{"narration":"...","visual":"...","screenText":"..."}],"caption":"..."}. Keep narration concise, scene visuals descriptive, screenText short, and caption include 3-5 relevant hashtags. Do not include markdown or explanations. Do not copy copyrighted stories or characters.`;
    const model=process.env.GEMINI_MODEL||"gemini-3.8-flash";
    const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const upstream=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":process.env.GEMINI_API_KEY},body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt}]}],generationConfig:{responseMimeType:"application/json",temperature:0.85,maxOutputTokens:5000}})});
    const data=await upstream.json();
    if(!upstream.ok){console.error("Gemini API error",upstream.status,data?.error?.status||"API_ERROR");return res.status(502).json({error:"خدمة Gemini لم تُكمل الطلب. تحقق من المفتاح واسم النموذج."});}
    const raw=(data.candidates||[]).flatMap(c=>c.content?.parts||[]).map(p=>p.text||"").join("").trim();
    const story=JSON.parse(raw.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,""));
    if(!story.title||!Array.isArray(story.scenes)||story.scenes.length!==count) throw new Error("Invalid story structure");
    story.scenes=story.scenes.map(x=>({narration:String(x.narration||""),visual:String(x.visual||""),screenText:String(x.screenText||"")}));
    res.json({...story,model});
  }catch(e){console.error("Story generation failed:",e.message);res.status(502).json({error:"تعذر تجهيز القصة بشكل صحيح. حاول مرة أخرى."});}
});

// TikTok OAuth: connects the user account only. Publishing endpoints are deliberately
// not enabled in this starter until app approval, video pipeline, consent UX and token
// storage have been implemented and reviewed.
app.get("/auth/tiktok",(req,res)=>{
  const {TIKTOK_CLIENT_KEY,TIKTOK_REDIRECT_URI,TIKTOK_CLIENT_SECRET}=process.env;
  if(!TIKTOK_CLIENT_KEY||!TIKTOK_CLIENT_SECRET||!TIKTOK_REDIRECT_URI)
    return res.status(503).send("TikTok غير مضبوط على الخادم. أضف إعدادات المطور أولاً.");
  const state=crypto.randomBytes(24).toString("hex");
  req.session.tiktokState=state;
  const u=new URL("https://www.tiktok.com/v2/auth/authorize/");
  u.search=new URLSearchParams({
    client_key:TIKTOK_CLIENT_KEY,response_type:"code",
    scope:"user.info.basic,video.publish",
    redirect_uri:TIKTOK_REDIRECT_URI,state
  }).toString();
  res.redirect(u.toString());
});

app.get("/auth/tiktok/callback",async(req,res)=>{
  try{
    const {code,state,error,error_description}=req.query;
    if(error) return res.status(400).send("لم تكتمل موافقة TikTok: "+String(error_description||error));
    if(!code||!state||!req.session.tiktokState||state!==req.session.tiktokState)
      return res.status(400).send("فشل التحقق من جلسة الربط. ارجع وابدأ الربط من جديد.");
    delete req.session.tiktokState;
    const form=new URLSearchParams({
      client_key:process.env.TIKTOK_CLIENT_KEY||"",
      client_secret:process.env.TIKTOK_CLIENT_SECRET||"",
      code:String(code),grant_type:"authorization_code",
      redirect_uri:process.env.TIKTOK_REDIRECT_URI||""
    });
    const tokenRes=await fetch("https://open.tiktokapis.com/v2/oauth/token/",{
      method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Cache-Control":"no-cache"},body:form
    });
    const token=await tokenRes.json();
    if(!tokenRes.ok||token.error) {
      console.error("TikTok token exchange failed",tokenRes.status,token.error||"TOKEN_ERROR");
      return res.status(502).send("تعذر إكمال ربط TikTok. راجع Redirect URI وصلاحيات التطبيق.");
    }
    // Temporary prototype storage in session only; not suitable for production.
    req.session.tiktokConnected=true;
    req.session.tiktokAccessToken=token.access_token;
    req.session.tiktokOpenId=token.open_id;
    res.redirect("/?tiktok=connected");
  }catch(e){
    console.error("TikTok callback failed:",e.message);
    res.status(500).send("حدث خطأ أثناء إكمال ربط TikTok.");
  }
});

app.get("/api/tiktok/status",(req,res)=>res.json({
  connected:Boolean(req.session.tiktokConnected),
  publishingEnabled:false
}));

app.listen(PORT,()=>console.log(`StoryMaster AI Ultimate listening on port ${PORT}`));
