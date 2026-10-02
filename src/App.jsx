import { useState, useEffect, useCallback } from "react";
import {
  AreaChart, Area, Line, XAxis, YAxis,
  Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid, ComposedChart
} from "recharts";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Put your Finnhub key in .env as VITE_FINNHUB_KEY to switch from simulated to live data
const FINNHUB_KEY = import.meta.env.VITE_FINNHUB_KEY ?? "";
const USE_LIVE = Boolean(FINNHUB_KEY); // live data when a key is configured, simulated otherwise

// ─── Live Finnhub loader ──────────────────────────────────────────────────────
async function fetchLive(ticker) {
  const B = "https://finnhub.io/api/v1";
  const K = `token=${FINNHUB_KEY}`;
  const now = Math.floor(Date.now() / 1000);
  const [quote, c5m, cDay, cMo, prof] = await Promise.all([
    fetch(`${B}/quote?symbol=${ticker}&${K}`).then(r => r.json()),
    fetch(`${B}/stock/candle?symbol=${ticker}&resolution=5&from=${now - 2 * 86400}&to=${now}&${K}`).then(r => r.json()),
    fetch(`${B}/stock/candle?symbol=${ticker}&resolution=D&from=${now - 366 * 86400}&to=${now}&${K}`).then(r => r.json()),
    fetch(`${B}/stock/candle?symbol=${ticker}&resolution=M&from=${now - 30 * 30 * 86400}&to=${now}&${K}`).then(r => r.json()),
    fetch(`${B}/stock/profile2?symbol=${ticker}&${K}`).then(r => r.json()),
  ]);
  if (!quote?.c || quote.c === 0) throw new Error(`No data for ${ticker}`);
  const parse = d => (!d || d.s !== "ok" || !d.t) ? [] : d.t.map((t, i) => ({ t, o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i], v: d.v[i] }));
  const dayStart = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime()/1000|0; })();
  const fiveMin = parse(c5m).filter(c => c.t >= dayStart);
  const daily = parse(cDay), monthly = parse(cMo);
  const price = quote.c, prev = quote.pc || price;
  const avgVol = daily.length > 5 ? daily.slice(-30).reduce((a,c)=>a+c.v,0)/Math.min(30,daily.length) : 0;
  const ranges = daily.slice(-20).map(c => (c.h - c.l)/c.c);
  const iv = Math.max(0.1, (ranges.reduce((a,b)=>a+b,0)/Math.max(ranges.length,1)) * 16);
  return { ticker, price, prev, change: price-prev, changePct: prev>0?(price-prev)/prev*100:0,
    volume: fiveMin.reduce((a,c)=>a+c.v,0)||quote.v||0, avgVolume: avgVol,
    high52: daily.length?Math.max(...daily.map(c=>c.h)):price,
    low52: daily.length?Math.min(...daily.map(c=>c.l)):price,
    iv, fiveMin, daily, monthly, name: prof?.name||ticker, exchange: prof?.exchange||"", logo: prof?.logo||"" };
}

// ─── Simulated data (used when no key is set) ─────────────────────────────────
function seeded(seed) {
  let s = seed >>> 0;
  return (lo=0, hi=1) => { s = (Math.imul(1664525,s)+1013904223)>>>0; return lo+(s/0xffffffff)*(hi-lo); };
}

const KNOWN = { SPY:548, QQQ:472, AAPL:211, NVDA:138, TSLA:248, MSFT:452, AMD:162, META:610, AMZN:185, GOOGL:175, JPM:205, GS:510 };

function generateStock(ticker) {
  const hash = [...ticker].reduce((a,c,i)=>a+c.charCodeAt(0)*(i+7),31337);
  const r = seeded(hash);
  const base = KNOWN[ticker] ?? (30 + r(20, 480));
  const ivBase = ticker==="SPY"?0.12:ticker==="QQQ"?0.16:0.15+r(0,0.35);

  function candles(n, spread, swing, volBase) {
    const rr = seeded(hash + n);
    let px = base * (1 - spread);
    return Array.from({length:n}, (_,i) => {
      const chg = rr(-swing, swing);
      const o = px; px = Math.max(px*0.3, px*(1+chg));
      const hi = Math.max(o,px)*(1+rr(0,swing*0.4));
      const lo = Math.min(o,px)*(1-rr(0,swing*0.4));
      return { t: Date.now()/1000 - (n-i)*300, o, h:hi, l:lo, c:px, v:rr(volBase*0.5,volBase*1.5) };
    }).map((c,i,a) => i===a.length-1?{...c,c:base}:c);
  }

  const fiveMin  = candles(78,  r(0.004,0.015), 0.005, 600000);
  const daily    = candles(252, r(0.08,0.28),   0.022, 25000000);
  const monthly  = candles(24,  r(0.15,0.45),   0.065, 400000000);
  const prev = daily[daily.length-2]?.c ?? base*0.99;

  return { ticker, price:base, prev, change:base-prev, changePct:(base-prev)/prev*100,
    volume: fiveMin.reduce((a,c)=>a+c.v,0),
    avgVolume: daily.slice(-30).reduce((a,c)=>a+c.v,0)/30,
    high52: Math.max(...daily.map(c=>c.h)), low52: Math.min(...daily.map(c=>c.l)),
    iv: ivBase, fiveMin, daily, monthly, name: ticker, exchange:"SIM", logo:"" };
}

async function loadTicker(ticker) {
  if (USE_LIVE) return fetchLive(ticker);
  await new Promise(res => setTimeout(res, 400 + Math.random()*300));
  return generateStock(ticker);
}

// ─── Math ─────────────────────────────────────────────────────────────────────
const sma = (a,n) => (!a||a.length<n)?null:a.slice(-n).reduce((x,y)=>x+y,0)/n;
function ema(a,n) {
  if(!a||a.length<n) return null;
  const k=2/(n+1); let v=a.slice(0,n).reduce((x,y)=>x+y,0)/n;
  for(let i=n;i<a.length;i++) v=a[i]*k+v*(1-k); return v;
}
function vwap(cs) {
  if(!cs?.length) return null;
  let tp=0,v=0; for(const c of cs){const t=(c.h+c.l+c.c)/3;tp+=t*c.v;v+=c.v;} return v?tp/v:null;
}
function rsi(a,n=14) {
  if(!a||a.length<n+1) return null;
  let g=0,l=0;
  for(let i=a.length-n;i<a.length;i++){const d=a[i]-a[i-1];d>0?g+=d:l+=Math.abs(d);}
  const ag=g/n,al=l/n; return al===0?100:100-100/(1+ag/al);
}
function beta(sr,pr) {
  const n=Math.min(sr.length,pr.length); if(n<2) return 1;
  const s=sr.slice(-n),p=pr.slice(-n),ms=s.reduce((a,b)=>a+b,0)/n,mp=p.reduce((a,b)=>a+b,0)/n;
  let cov=0,vp=0; for(let i=0;i<n;i++){cov+=(s[i]-ms)*(p[i]-mp);vp+=(p[i]-mp)**2;}
  return vp?cov/vp:1;
}
function corr(a,b) {
  const n=Math.min(a.length,b.length); if(n<2) return 0;
  const as=a.slice(-n),bs=b.slice(-n),ma=as.reduce((x,y)=>x+y,0)/n,mb=bs.reduce((x,y)=>x+y,0)/n;
  let num=0,da=0,db=0;
  for(let i=0;i<n;i++){num+=(as[i]-ma)*(bs[i]-mb);da+=(as[i]-ma)**2;db+=(bs[i]-mb)**2;}
  return (da&&db)?num/Math.sqrt(da*db):0;
}
function emaSeries(a,n) {
  if(!a||a.length<n) return [];
  const k=2/(n+1); let v=a.slice(0,n).reduce((x,y)=>x+y,0)/n;
  const out=Array(n-1).fill(null); out.push(v);
  for(let i=n;i<a.length;i++){v=a[i]*k+v*(1-k);out.push(v);} return out;
}
function smaSeries(a,n) {
  if(!a) return [];
  return a.map((_,i)=>i<n-1?null:a.slice(i-n+1,i+1).reduce((x,y)=>x+y,0)/n);
}

function analyze(stock, spy) {
  const fm=stock.fiveMin.map(c=>c.c), day=stock.daily.map(c=>c.c), mo=stock.monthly.map(c=>c.c);
  const spyDay=spy?.daily.map(c=>c.c)??[], spyFm=spy?.fiveMin.map(c=>c.c)??[];
  const ret=arr=>arr.slice(1).map((c,i)=>(c-arr[i])/arr[i]);
  const b=beta(ret(day),ret(spyDay)), c=corr(ret(day),ret(spyDay)), ic=corr(ret(fm),ret(spyFm));
  const ind={
    fm:{ema9:ema(fm,9),ema21:ema(fm,21),sma20:sma(fm,20),vwap:vwap(stock.fiveMin),rsi:rsi(fm,14)},
    day:{sma20:sma(day,20),sma50:sma(day,50),sma200:sma(day,200),ema9:ema(day,9),ema21:ema(day,21),vwap:vwap(stock.daily.slice(-20)),rsi:rsi(day)},
    mo:{sma10:sma(mo,10),ema12:ema(mo,12),ema26:ema(mo,26),rsi:rsi(mo,9)},
  };
  const p=stock.price;
  function sig(pr,e,s,v){let bl=0,br=0;if(s){pr>s?bl++:br++;}if(e){pr>e?bl++:br++;}if(v){pr>v?bl++:br++;}if(e&&s){e>s?bl++:br++;}return bl>=3?"Bullish":br>=3?"Bearish":"Mixed";}
  const sig5=sig(p,ind.fm.ema9,ind.fm.sma20,ind.fm.vwap);
  const sigD=sig(p,ind.day.ema9,ind.day.sma20,ind.day.vwap);
  const sigM=ind.mo.ema12&&ind.mo.sma10?(p>ind.mo.ema12&&p>ind.mo.sma10?"Bullish":p<ind.mo.ema12&&p<ind.mo.sma10?"Bearish":"Mixed"):"Mixed";
  const bl=[sig5,sigD,sigM].filter(x=>x==="Bullish").length, br=[sig5,sigD,sigM].filter(x=>x==="Bearish").length;
  const bias=bl>br?"Call":br>bl?"Put":"Neutral";
  const recent=stock.daily.slice(-20);
  const res=[...recent.map(c=>c.h)].sort((a,b)=>b-a).slice(0,3);
  const sup=[...recent.map(c=>c.l)].sort((a,b)=>a-b).slice(0,3);
  const iv=stock.iv??0.2, ivRank=Math.min(99,Math.round(iv*190));
  return {ind,beta:b,correlation:c,intradayCorr:ic,sig5,sigD,sigM,bias,resistance:res,support:sup,ivRank,
    move1d:p*iv*Math.sqrt(1/365),move7d:p*iv*Math.sqrt(7/365),move30d:p*iv*Math.sqrt(30/365),
    volRatio:stock.avgVolume>0?stock.volume/stock.avgVolume:1};
}

// ─── Design ───────────────────────────────────────────────────────────────────
const C = {
  bull:"#10b981", bear:"#ef4444", neutral:"#f59e0b", accent:"#6366f1",
  surface:"#ffffff", bg:"#f8fafc", border:"#e2e8f0", text:"#0f172a", muted:"#64748b"
};

// ─── Components ───────────────────────────────────────────────────────────────
function Pill({signal}) {
  const m={Bullish:{bg:"#dcfce7",fg:"#15803d",dot:C.bull},Bearish:{bg:"#fee2e2",fg:"#b91c1c",dot:C.bear},Mixed:{bg:"#fef3c7",fg:"#92400e",dot:C.neutral},Neutral:{bg:"#f1f5f9",fg:"#475569",dot:"#94a3b8"}};
  const s=m[signal]??m.Neutral;
  return <span style={{display:"inline-flex",alignItems:"center",gap:5,background:s.bg,color:s.fg,borderRadius:20,padding:"3px 10px",fontSize:12,fontWeight:600}}><span style={{width:7,height:7,borderRadius:"50%",background:s.dot,display:"inline-block"}}/>{signal}</span>;
}

function RSIArc({value}) {
  const v=value??50, color=v>70?C.bear:v<30?C.bull:C.accent, label=v>70?"Overbought":v<30?"Oversold":"Neutral";
  const r=28, circ=Math.PI*r, pct=Math.min(1,Math.max(0,v/100));
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
      <svg width={72} height={46} viewBox="0 0 72 46">
        <path d="M 8 38 A 28 28 0 0 1 64 38" fill="none" stroke="#e2e8f0" strokeWidth={8} strokeLinecap="round"/>
        <path d="M 8 38 A 28 28 0 0 1 64 38" fill="none" stroke={color} strokeWidth={8} strokeLinecap="round" strokeDasharray={`${pct*circ} ${circ}`}/>
      </svg>
      <div style={{fontSize:17,fontWeight:700,color:C.text,marginTop:-6}}>{v.toFixed(0)}</div>
      <div style={{fontSize:10,color:C.muted}}>{label}</div>
    </div>
  );
}

function Spark({candles,w=110,h=40}) {
  const src = candles?.length ? candles : [];
  if (!src.length) return <div style={{width:w,height:h,background:"#f1f5f9",borderRadius:6}}/>;
  const cs=src.map(c=>c.c), mn=Math.min(...cs), mx=Math.max(...cs), rng=mx-mn||1;
  const pts=cs.map((v,i)=>({x:(i/Math.max(cs.length-1,1))*w,y:h-((v-mn)/rng)*(h-3)-1}));
  const isUp=cs[cs.length-1]>=cs[0], col=isUp?C.bull:C.bear;
  const d=pts.map((p,i)=>`${i===0?"M":"L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h}>
      <path d={`${d} L${w},${h} L0,${h}Z`} fill={col} fillOpacity={0.1}/>
      <path d={d} fill="none" stroke={col} strokeWidth={2} strokeLinejoin="round"/>
    </svg>
  );
}

function PChart({candles, e9arr, s20arr, vwapV, title}) {
  if (!candles?.length) return (
    <div style={{height:140,display:"flex",alignItems:"center",justifyContent:"center",background:"#f8fafc",borderRadius:8,fontSize:12,color:C.muted}}>
      No candle data
    </div>
  );
  const src=candles.slice(-60), closes=src.map(c=>c.c);
  const isUp=closes[closes.length-1]>=closes[0];
  const e9s=e9arr?.slice(-60)??[], s20s=s20arr?.slice(-60)??[];
  const data=closes.map((c,i)=>({i,price:+c.toFixed(2),ema9:e9s[i]?+e9s[i].toFixed(2):null,sma20:s20s[i]?+s20s[i].toFixed(2):null}));
  const all=[...closes,...e9s.filter(Boolean),...s20s.filter(Boolean),vwapV].filter(Boolean);
  const minY=Math.min(...all)*0.998, maxY=Math.max(...all)*1.002;
  const gid=`g${title.replace(/\W/g,"")}`;
  return (
    <div>
      <div style={{fontSize:12,fontWeight:600,color:C.muted,marginBottom:6}}>{title}</div>
      <ResponsiveContainer width="100%" height={140}>
        <ComposedChart data={data} margin={{top:2,right:2,bottom:0,left:0}}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={isUp?C.bull:C.bear} stopOpacity={0.18}/>
              <stop offset="100%" stopColor={isUp?C.bull:C.bear} stopOpacity={0}/>
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#f1f5f9" vertical={false}/>
          <YAxis domain={[minY,maxY]} hide/>
          <XAxis dataKey="i" hide/>
          <Tooltip contentStyle={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,fontSize:11,boxShadow:"0 4px 12px rgba(0,0,0,0.08)"}} formatter={(v,n)=>[v!=null?`$${v}`:"—",n==="price"?"Price":n==="ema9"?"EMA 9":"SMA 20"]} labelFormatter={()=>""}/>
          {vwapV&&<ReferenceLine y={vwapV} stroke={C.accent} strokeDasharray="4 3" strokeWidth={1.5} label={{value:"VWAP",position:"insideTopRight",fontSize:9,fill:C.accent}}/>}
          <Area dataKey="price" stroke={isUp?C.bull:C.bear} strokeWidth={2} fill={`url(#${gid})`} dot={false}/>
          <Line dataKey="ema9" stroke="#f59e0b" strokeWidth={1.5} dot={false} connectNulls/>
          <Line dataKey="sma20" stroke={C.accent} strokeWidth={1.5} dot={false} connectNulls strokeDasharray="5 3"/>
        </ComposedChart>
      </ResponsiveContainer>
      <div style={{display:"flex",gap:10,marginTop:5,flexWrap:"wrap"}}>
        {[["Price",isUp?C.bull:C.bear],["EMA 9","#f59e0b"],["SMA 20",C.accent],...(vwapV?[["VWAP",C.accent]]:[])].map(([l,col])=>(
          <span key={l} style={{display:"flex",alignItems:"center",gap:4,fontSize:10,color:C.muted}}>
            <span style={{width:14,height:2,background:col,display:"inline-block",borderRadius:1}}/>{l}
          </span>
        ))}
      </div>
    </div>
  );
}

function IndTable({items, price}) {
  const rows=items.filter(([,v])=>v!=null);
  if(!rows.length) return <div style={{fontSize:12,color:C.muted,padding:"8px 0"}}>Insufficient data</div>;
  return (
    <table style={{width:"100%",borderCollapse:"collapse"}}>
      <tbody>
        {rows.map(([name,val])=>{
          const above=price>val;
          return (
            <tr key={name} style={{borderBottom:`1px solid ${C.border}`}}>
              <td style={{padding:"5px 0",fontSize:12,color:C.muted}}>{name}</td>
              <td style={{padding:"5px 0",fontSize:12,fontWeight:600,color:C.text,textAlign:"right"}}>${val.toFixed(2)}</td>
              <td style={{padding:"5px 4px",textAlign:"right"}}>
                <span style={{fontSize:11,fontWeight:600,color:above?C.bear:C.bull}}>
                  {above?`−${((price-val)/price*100).toFixed(1)}%`:`+${((val-price)/price*100).toFixed(1)}%`}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Levels({price, resistance, support}) {
  if(!resistance?.length&&!support?.length) return null;
  const all=[...resistance,...support,price].sort((a,b)=>a-b);
  const mn=Math.min(...all)*0.996, mx=Math.max(...all)*1.004, rng=mx-mn;
  const pct=v=>((v-mn)/rng)*100;
  return (
    <div style={{position:"relative",height:110,marginTop:8,borderRadius:8,background:"linear-gradient(to top,rgba(16,185,129,0.04),rgba(239,68,68,0.04))"}}>
      {resistance.map((r,i)=>(
        <div key={`r${i}`} style={{position:"absolute",width:"100%",bottom:`${pct(r)}%`,transform:"translateY(50%)",display:"flex",alignItems:"center",gap:5}}>
          <div style={{flex:1,height:1,background:C.bear,opacity:0.45}}/><span style={{fontSize:10,color:C.bear,fontWeight:600,whiteSpace:"nowrap"}}>R{i+1} ${r.toFixed(2)}</span>
        </div>
      ))}
      {support.map((s,i)=>(
        <div key={`s${i}`} style={{position:"absolute",width:"100%",bottom:`${pct(s)}%`,transform:"translateY(50%)",display:"flex",alignItems:"center",gap:5}}>
          <div style={{flex:1,height:1,background:C.bull,opacity:0.45}}/><span style={{fontSize:10,color:C.bull,fontWeight:600,whiteSpace:"nowrap"}}>S{i+1} ${s.toFixed(2)}</span>
        </div>
      ))}
      <div style={{position:"absolute",width:"100%",bottom:`${pct(price)}%`,transform:"translateY(50%)",display:"flex",alignItems:"center",gap:5,zIndex:2}}>
        <div style={{flex:1,height:2,background:C.accent,borderRadius:1}}/><span style={{fontSize:11,color:C.accent,fontWeight:700,whiteSpace:"nowrap"}}>${price.toFixed(2)}</span>
      </div>
    </div>
  );
}

function Card({children, style={}}) {
  return <div style={{background:C.surface,borderRadius:16,border:`1px solid ${C.border}`,padding:20,boxShadow:"0 1px 4px rgba(0,0,0,0.04)",...style}}>{children}</div>;
}

function Section({children}) {
  return <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:12}}>{children}</div>;
}

function Loader() {
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16,padding:"80px 0"}}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{width:40,height:40,border:`3px solid ${C.border}`,borderTop:`3px solid ${C.accent}`,borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
      <span style={{color:C.muted,fontSize:14}}>Loading data…</span>
    </div>
  );
}

// ─── Main ticker view ─────────────────────────────────────────────────────────
function TickerView({ticker, stock, an, spy, onRemove}) {
  const up=stock.changePct>=0;
  const biasCol=an.bias==="Call"?C.bull:an.bias==="Put"?C.bear:C.neutral;
  const fm=stock.fiveMin.map(c=>c.c), day=stock.daily.map(c=>c.c), mo=stock.monthly.map(c=>c.c);
  const strikes=[-0.05,-0.03,-0.02,-0.01,0,0.01,0.02,0.03,0.05].map(d=>Math.round(stock.price*(1+d)/0.5)*0.5);

  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>

      {/* Header */}
      <Card style={{background:up?"linear-gradient(135deg,#f0fdf4,#dcfce7)":"linear-gradient(135deg,#fff1f2,#fee2e2)",borderColor:up?"#bbf7d0":"#fecaca"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6,flexWrap:"wrap"}}>
              {stock.logo&&<img src={stock.logo} alt="" style={{width:24,height:24,borderRadius:6,background:"#fff",padding:2,objectFit:"contain"}} onError={e=>e.target.style.display="none"}/>}
              <span style={{fontSize:26,fontWeight:800,color:C.text,letterSpacing:-1}}>{ticker}</span>
              {stock.name&&stock.name!==ticker&&<span style={{fontSize:13,color:C.muted,fontWeight:400}}>{stock.name}</span>}
              <span style={{background:biasCol,color:"#fff",fontSize:12,fontWeight:700,borderRadius:20,padding:"3px 12px"}}>{an.bias==="Neutral"?"Neutral":`${an.bias} Bias`}</span>
              {!USE_LIVE&&<span style={{fontSize:10,background:"#fef9c3",color:"#713f12",borderRadius:20,padding:"2px 8px",fontWeight:600}}>Simulated</span>}
            </div>
            <div style={{display:"flex",alignItems:"baseline",gap:10}}>
              <span style={{fontSize:40,fontWeight:800,color:C.text,letterSpacing:-2}}>${stock.price.toFixed(2)}</span>
              <span style={{fontSize:18,fontWeight:700,color:up?C.bull:C.bear}}>{up?"▲":"▼"} {Math.abs(stock.changePct).toFixed(2)}%</span>
              <span style={{fontSize:14,color:C.muted}}>{up?"+":""}{stock.change.toFixed(2)}</span>
            </div>
            <div style={{fontSize:12,color:C.muted,marginTop:2}}>Prev close ${stock.prev.toFixed(2)}{stock.exchange&&stock.exchange!=="SIM"?` · ${stock.exchange}`:""}</div>
          </div>
          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8}}>
            <Spark candles={stock.fiveMin.length?stock.fiveMin:stock.daily.slice(-50)}/>
            <button onClick={()=>onRemove(ticker)} style={{fontSize:11,color:"#94a3b8",background:"none",border:"none",cursor:"pointer",padding:0,marginTop:4}}>Remove</button>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginTop:14,paddingTop:14,borderTop:`1px solid ${up?"#bbf7d0":"#fecaca"}`}}>
          {[["52W High",`$${stock.high52.toFixed(2)}`],["52W Low",`$${stock.low52.toFixed(2)}`],["Volume",`${(stock.volume/1e6).toFixed(1)}M`],["Vol Ratio",stock.avgVolume>0?`${an.volRatio.toFixed(1)}×`:"—"]].map(([l,v])=>(
            <div key={l}>
              <div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:0.8,marginBottom:2}}>{l}</div>
              <div style={{fontSize:15,fontWeight:700,color:C.text}}>{v}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* 3 Charts */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:14}}>
        {[
          {candles:stock.fiveMin,e9:emaSeries(fm,9).slice(-60),s20:smaSeries(fm,20).slice(-60),vwapV:an.ind.fm.vwap,title:"5-Minute",sig:an.sig5},
          {candles:stock.daily,e9:emaSeries(day,9).slice(-60),s20:smaSeries(day,20).slice(-60),vwapV:an.ind.day.vwap,title:"Daily",sig:an.sigD},
          {candles:stock.monthly,e9:emaSeries(mo,12).slice(-24),s20:smaSeries(mo,10).slice(-24),vwapV:null,title:"Monthly",sig:an.sigM},
        ].map(({candles,e9,s20,vwapV,title,sig})=>(
          <Card key={title}>
            <PChart candles={candles} e9arr={e9} s20arr={s20} vwapV={vwapV} title={`${title} Chart`}/>
            <div style={{marginTop:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:11,color:C.muted}}>Signal</span><Pill signal={sig}/>
            </div>
          </Card>
        ))}
      </div>

      {/* Indicators + RSI */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:14}}>
        <Card>
          <Section>5-Min Indicators</Section>
          <IndTable price={stock.price} items={[["EMA 9",an.ind.fm.ema9],["EMA 21",an.ind.fm.ema21],["SMA 20",an.ind.fm.sma20],["VWAP",an.ind.fm.vwap]]}/>
        </Card>
        <Card>
          <Section>Daily Indicators</Section>
          <IndTable price={stock.price} items={[["EMA 9",an.ind.day.ema9],["EMA 21",an.ind.day.ema21],["SMA 20",an.ind.day.sma20],["SMA 50",an.ind.day.sma50],["SMA 200",an.ind.day.sma200],["VWAP (20d)",an.ind.day.vwap]]}/>
        </Card>
        <Card>
          <Section>Monthly Indicators</Section>
          <IndTable price={stock.price} items={[["EMA 12",an.ind.mo.ema12],["EMA 26",an.ind.mo.ema26],["SMA 10",an.ind.mo.sma10]]}/>
          <div style={{marginTop:16}}>
            <div style={{fontSize:11,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:10}}>RSI Readings</div>
            <div style={{display:"flex",justifyContent:"space-around"}}>
              {[["5-Min",an.ind.fm.rsi],["Daily",an.ind.day.rsi],["Monthly",an.ind.mo.rsi]].map(([l,v])=>(
                <div key={l} style={{textAlign:"center"}}><RSIArc value={v}/><div style={{fontSize:10,color:C.muted,marginTop:3}}>{l}</div></div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      {/* SPY + Levels + Options */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:14}}>
        {/* SPY */}
        <Card>
          <Section>SPY Relationship</Section>
          {[
            {l:"Daily Beta",v:an.beta?.toFixed(2),n:an.beta>1.5?"High sensitivity":an.beta>0.8?"Moves with SPY":"Low correlation",col:an.beta>1.5?C.bear:an.beta>0.8?C.accent:C.muted},
            {l:"Daily Corr.",v:an.correlation?.toFixed(2),n:an.correlation>0.7?"Strongly correlated":an.correlation>0.3?"Moderate":"Weak",col:an.correlation>0.7?C.bull:C.muted},
            {l:"Intraday Corr.",v:an.intradayCorr?.toFixed(2),n:an.intradayCorr>0.7?"Tracks SPY closely":"Diverges intraday",col:an.intradayCorr>0.5?C.bull:C.neutral},
          ].map(({l,v,n,col})=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:`1px solid ${C.border}`}}>
              <div><div style={{fontSize:12,fontWeight:600,color:C.text}}>{l}</div><div style={{fontSize:11,color:C.muted}}>{n}</div></div>
              <div style={{fontSize:22,fontWeight:800,color:col}}>{v??"—"}</div>
            </div>
          ))}
          {spy&&(
            <div style={{marginTop:12,background:C.bg,borderRadius:10,padding:12}}>
              <div style={{fontSize:11,color:C.muted,marginBottom:3}}>SPY today</div>
              <div style={{fontSize:16,fontWeight:700,color:spy.changePct>=0?C.bull:C.bear}}>{spy.changePct>=0?"▲":"▼"} {Math.abs(spy.changePct).toFixed(2)}%&nbsp;&nbsp;${spy.price.toFixed(2)}</div>
              <div style={{fontSize:11,color:C.muted,marginTop:4}}>Implied {ticker} move: <strong style={{color:C.text}}>{(Math.abs(spy.changePct)*an.beta).toFixed(2)}%</strong></div>
            </div>
          )}
        </Card>

        {/* Levels */}
        <Card>
          <Section>Key Price Levels</Section>
          <Levels price={stock.price} resistance={an.resistance} support={an.support}/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:14}}>
            <div>
              <div style={{fontSize:11,fontWeight:700,color:C.bear,marginBottom:6,textTransform:"uppercase",letterSpacing:0.8}}>Resistance</div>
              {an.resistance.map((r,i)=>(
                <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12}}>
                  <span style={{color:C.muted}}>R{i+1}</span><span style={{fontWeight:600,color:C.text}}>${r.toFixed(2)}</span>
                  <span style={{color:C.bear,fontSize:11}}>+{((r-stock.price)/stock.price*100).toFixed(1)}%</span>
                </div>
              ))}
            </div>
            <div>
              <div style={{fontSize:11,fontWeight:700,color:C.bull,marginBottom:6,textTransform:"uppercase",letterSpacing:0.8}}>Support</div>
              {an.support.map((s,i)=>(
                <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12}}>
                  <span style={{color:C.muted}}>S{i+1}</span><span style={{fontWeight:600,color:C.text}}>${s.toFixed(2)}</span>
                  <span style={{color:C.bull,fontSize:11}}>{((s-stock.price)/stock.price*100).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </div>
        </Card>

        {/* Options */}
        <Card>
          <Section>Options Intelligence</Section>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
            {[["IV (est.)",`${((stock.iv??0.2)*100).toFixed(1)}%`],["IV Rank",`${an.ivRank}/100`],["±1-Day",`$${an.move1d.toFixed(2)}`],["±7-Day",`$${an.move7d.toFixed(2)}`]].map(([l,v])=>(
              <div key={l} style={{background:C.bg,borderRadius:10,padding:10}}>
                <div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:0.8,marginBottom:3}}>{l}</div>
                <div style={{fontSize:16,fontWeight:700,color:C.text}}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
              <span style={{fontSize:11,color:C.muted}}>IV Rank</span>
              <span style={{fontSize:11,fontWeight:600,color:an.ivRank>70?C.bear:an.ivRank<30?C.bull:C.neutral}}>{an.ivRank>70?"Sell premium":an.ivRank<30?"Buy premium":"Moderate IV"}</span>
            </div>
            <div style={{height:6,borderRadius:99,background:C.border,overflow:"hidden"}}>
              <div style={{height:"100%",width:`${an.ivRank}%`,background:an.ivRank>70?C.bear:an.ivRank<30?C.bull:C.neutral,borderRadius:99}}/>
            </div>
          </div>
          <div style={{fontSize:11,color:C.muted,marginBottom:8}}>Nearby strikes</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
            {strikes.map(s=>{
              const call=s>=stock.price;
              return <span key={s} style={{fontSize:11,fontWeight:600,borderRadius:8,padding:"3px 8px",background:call?"#dcfce7":"#fee2e2",color:call?"#15803d":"#b91c1c",border:`1px solid ${call?"#bbf7d0":"#fecaca"}`}}>${s.toFixed(1)}</span>;
            })}
          </div>
        </Card>
      </div>

      {/* Setup summary */}
      <Card style={{background:an.bias==="Call"?"linear-gradient(135deg,#f0fdf4,#ecfdf5)":an.bias==="Put"?"linear-gradient(135deg,#fff1f2,#fef2f2)":"linear-gradient(135deg,#fffbeb,#fef9c3)",borderColor:an.bias==="Call"?"#bbf7d0":an.bias==="Put"?"#fecaca":"#fde68a"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:10}}>
          <Section>Day Trade Setup Summary</Section>
          <div style={{display:"flex",gap:8}}>
            {[["5-Min",an.sig5],["Daily",an.sigD],["Monthly",an.sigM]].map(([l,s])=>(
              <div key={l} style={{textAlign:"center"}}><div style={{fontSize:10,color:C.muted,marginBottom:4}}>{l}</div><Pill signal={s}/></div>
            ))}
          </div>
        </div>
        <p style={{fontSize:13,color:C.text,lineHeight:1.7,margin:0}}>
          {an.bias==="Call"
            ?`${ticker} shows bullish alignment across timeframes. Price is above key moving averages${an.ind.fm.vwap?` and VWAP ($${an.ind.fm.vwap.toFixed(2)})`:""}. Watch for continuation above R1 at $${an.resistance[0]?.toFixed(2)}. ${an.ivRank<50?"IV is moderate — favorable for buying calls.":"IV is elevated — size positions carefully."} Risk to S1 at $${an.support[0]?.toFixed(2)}.`
            :an.bias==="Put"
            ?`${ticker} shows bearish pressure — price below key MAs${an.ind.fm.vwap?` and VWAP ($${an.ind.fm.vwap.toFixed(2)})`:""}. Target S1 at $${an.support[0]?.toFixed(2)}, then $${an.support[1]?.toFixed(2)}. Beta of ${an.beta?.toFixed(1)} means a 1% SPY drop implies ~${an.beta?.toFixed(1)}% on ${ticker}.`
            :`Mixed signals on ${ticker}. Wait for 5-min confirmation — a close above VWAP${an.ind.fm.vwap?` ($${an.ind.fm.vwap.toFixed(2)})`:""}  favors calls; a break below SMA 20${an.ind.fm.sma20?` ($${an.ind.fm.sma20.toFixed(2)})`:""}  favors puts. Watch SPY for directional cue.`
          }
        </p>
      </Card>
    </div>
  );
}

// ─── App shell ────────────────────────────────────────────────────────────────
export default function App() {
  const [tickers, setTickers]     = useState(["SPY","NVDA"]);
  const [input, setInput]         = useState("");
  const [stocks, setStocks]       = useState({});
  const [loadingSet, setLoadingSet] = useState(new Set());
  const [errors, setErrors]       = useState({});
  const [active, setActive]       = useState("SPY");
  const [aiText, setAiText]       = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [updated, setUpdated]     = useState(null);

  const load = useCallback(async (ticker) => {
    setLoadingSet(s=>{const n=new Set(s);n.add(ticker);return n;});
    setErrors(e=>{const n={...e};delete n[ticker];return n;});
    try {
      const data = await loadTicker(ticker);
      setStocks(p=>({...p,[ticker]:data}));
      setUpdated(new Date());
    } catch(err) {
      setErrors(e=>({...e,[ticker]:String(err.message||err)}));
    }
    setLoadingSet(s=>{const n=new Set(s);n.delete(ticker);return n;});
  },[]);

  useEffect(()=>{tickers.forEach(t=>load(t));},[]);
  useEffect(()=>{
    const id=setInterval(()=>tickers.forEach(t=>load(t)),60000);
    return()=>clearInterval(id);
  },[tickers,load]);

  const add = () => {
    const sym=input.trim().toUpperCase().replace(/[^A-Z]/g,"");
    if(!sym||tickers.includes(sym)){setInput("");return;}
    setTickers(p=>[...p,sym]); setInput(""); setActive(sym); load(sym);
  };
  const remove = t => {
    const next=tickers.filter(x=>x!==t);
    setTickers(next); setStocks(p=>{const n={...p};delete n[t];return n;});
    if(active===t) setActive(next[0]??"");
  };

  const getAI = async () => {
    if(!stocks[active]) return;
    setAiLoading(true); setAiText("");
    const s=stocks[active], an=analyze(s,stocks["SPY"]??null);
    const summary=`${active} (${s.name}) — $${s.price.toFixed(2)}, Chg ${s.changePct.toFixed(2)}%, Bias ${an.bias}, 5m ${an.sig5}, Daily ${an.sigD}, Monthly ${an.sigM}, Beta ${an.beta?.toFixed(2)}, IV ${((s.iv??0.2)*100).toFixed(1)}%, IVRank ${an.ivRank}, VWAP(5m) $${an.ind.fm.vwap?.toFixed(2)??"n/a"}, RSI(5m) ${an.ind.fm.rsi?.toFixed(1)??"n/a"}, RSI(day) ${an.ind.day.rsi?.toFixed(1)??"n/a"}, EMA9(5m) $${an.ind.fm.ema9?.toFixed(2)??"n/a"}, SMA20 $${an.ind.day.sma20?.toFixed(2)??"n/a"}, SMA50 $${an.ind.day.sma50?.toFixed(2)??"n/a"}, SMA200 $${an.ind.day.sma200?.toFixed(2)??"n/a"}, R1 $${an.resistance[0]?.toFixed(2)}, S1 $${an.support[0]?.toFixed(2)}, SPY ${stocks["SPY"]?.changePct?.toFixed(2)??"n/a"}%`;
    try {
      const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-6",max_tokens:900,system:"You are an expert options day trader. Given technical analysis data, give a specific actionable trade plan in 4-6 sentences: market context, options strategy (call/put, strike, DTE), entry trigger, profit target, stop level.",messages:[{role:"user",content:`Options day trade plan for ${active}:\n\n${summary}`}]})});
      const d=await res.json();
      setAiText(d.content?.map(b=>b.text||"").join("")||"No response.");
    } catch { setAiText("Could not reach AI. Please try again."); }
    setAiLoading(false);
  };

  const st=stocks[active], an=st?analyze(st,stocks["SPY"]??null):null, isLd=loadingSet.has(active);

  return (
    <div style={{minHeight:"100vh",background:C.bg,fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif",color:C.text}}>
      <style>{`*{box-sizing:border-box} button{cursor:pointer;transition:opacity .15s} button:hover{opacity:.8} input:focus{outline:none;border-color:#6366f1!important}`}</style>

      {/* Nav */}
      <nav style={{background:C.surface,borderBottom:`1px solid ${C.border}`,position:"sticky",top:0,zIndex:50,boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
        <div style={{maxWidth:1400,margin:"0 auto",padding:"0 20px",height:60,display:"flex",alignItems:"center",gap:12}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginRight:4,flexShrink:0}}>
            <div style={{width:30,height:30,borderRadius:8,background:"linear-gradient(135deg,#6366f1,#818cf8)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15}}>📈</div>
            <span style={{fontSize:15,fontWeight:800,letterSpacing:-0.5}}>TradeScope</span>
            {!USE_LIVE&&<span style={{fontSize:10,background:"#fef9c3",color:"#713f12",borderRadius:20,padding:"2px 7px",fontWeight:700}}>SIM</span>}
            {USE_LIVE&&<span style={{fontSize:10,background:"#dcfce7",color:"#15803d",borderRadius:20,padding:"2px 7px",fontWeight:700}}>LIVE</span>}
          </div>

          <div style={{display:"flex",gap:4,flex:1,overflowX:"auto",paddingBottom:2}}>
            {tickers.map(t=>{
              const s=stocks[t], isA=t===active, up=(s?.changePct??0)>=0, ld=loadingSet.has(t), err=!!errors[t];
              return (
                <button key={t} onClick={()=>setActive(t)} style={{display:"flex",alignItems:"center",gap:5,padding:"5px 12px",borderRadius:10,border:`1px solid ${isA?C.accent:C.border}`,background:isA?"#eef2ff":"transparent",whiteSpace:"nowrap",outline:"none",flexShrink:0}}>
                  <span style={{fontSize:13,fontWeight:700,color:err?C.bear:isA?C.accent:C.text}}>{t}</span>
                  {ld&&<span style={{fontSize:11,color:C.muted}}>…</span>}
                  {!ld&&s&&<span style={{fontSize:12,fontWeight:600,color:up?C.bull:C.bear}}>{up?"▲":"▼"}{Math.abs(s.changePct).toFixed(2)}%</span>}
                  {!ld&&err&&<span style={{fontSize:11,color:C.bear}}>✕</span>}
                </button>
              );
            })}
          </div>

          <div style={{display:"flex",gap:8,alignItems:"center",flexShrink:0}}>
            {updated&&<span style={{fontSize:11,color:C.muted,whiteSpace:"nowrap"}}>{updated.toLocaleTimeString()}</span>}
            <input value={input} onChange={e=>setInput(e.target.value.toUpperCase())} onKeyDown={e=>e.key==="Enter"&&add()}
              placeholder="Ticker…" style={{width:90,padding:"6px 10px",border:`1px solid ${C.border}`,borderRadius:10,fontSize:13,fontWeight:600,background:C.surface}}/>
            <button onClick={add} style={{padding:"6px 14px",background:C.accent,color:"#fff",border:"none",borderRadius:10,fontSize:13,fontWeight:700}}>Add</button>
            <button onClick={()=>tickers.forEach(t=>load(t))} style={{padding:"6px 12px",border:`1px solid ${C.border}`,background:C.surface,borderRadius:10,fontSize:13,color:C.muted}}>↺</button>
          </div>
        </div>
      </nav>

      {/* Content */}
      <main style={{maxWidth:1400,margin:"0 auto",padding:20}}>
        {/* AI bar */}
        <div style={{marginBottom:18}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:aiText?10:0}}>
            <button onClick={getAI} disabled={aiLoading||!st} style={{display:"flex",alignItems:"center",gap:7,padding:"9px 18px",background:"linear-gradient(135deg,#6366f1,#818cf8)",color:"#fff",border:"none",borderRadius:12,fontSize:13,fontWeight:700,boxShadow:"0 2px 8px rgba(99,102,241,0.28)",opacity:(aiLoading||!st)?0.55:1}}>
              <span>{aiLoading?"⏳":"✦"}</span>{aiLoading?`Analyzing ${active}…`:`AI Trade Plan — ${active}`}
            </button>
            {aiText&&<button onClick={()=>setAiText("")} style={{fontSize:12,color:C.muted,background:"none",border:"none"}}>Clear</button>}
          </div>
          {aiText&&(
            <div style={{background:"linear-gradient(135deg,#eef2ff,#f5f3ff)",border:"1px solid #c7d2fe",borderRadius:14,padding:16}}>
              <div style={{fontSize:11,fontWeight:700,color:C.accent,marginBottom:7,textTransform:"uppercase",letterSpacing:1}}>✦ AI Trade Plan — {active}</div>
              <p style={{fontSize:14,color:C.text,lineHeight:1.7,margin:0}}>{aiText}</p>
            </div>
          )}
        </div>

        {errors[active]&&(
          <Card style={{borderColor:"#fecaca",background:"#fff1f2",marginBottom:14}}>
            <div style={{fontWeight:600,color:C.bear,marginBottom:4}}>Could not load {active}</div>
            <div style={{fontSize:13,color:C.muted,marginBottom:10}}>{errors[active]}</div>
            <button onClick={()=>load(active)} style={{padding:"6px 14px",background:C.bear,color:"#fff",border:"none",borderRadius:8,fontSize:13}}>Retry</button>
          </Card>
        )}

        {isLd&&!st&&<Loader/>}
        {!isLd&&!errors[active]&&st&&an&&<TickerView ticker={active} stock={st} an={an} spy={stocks["SPY"]} onRemove={remove}/>}
        {!active&&<div style={{textAlign:"center",padding:80,color:C.muted}}><div style={{fontSize:44,marginBottom:10}}>📊</div><div style={{fontSize:17,fontWeight:600}}>Add a ticker to begin</div></div>}

        <p style={{textAlign:"center",fontSize:11,color:"#cbd5e1",marginTop:28,paddingBottom:8}}>
          {USE_LIVE?"Live data via Finnhub · Auto-refreshes every 60s · ":"Simulated data — set VITE_FINNHUB_KEY to go live · "}Educational purposes only · Not financial advice
        </p>
      </main>
    </div>
  );
}
