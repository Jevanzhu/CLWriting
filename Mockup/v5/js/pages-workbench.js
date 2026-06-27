// ===== 工作台态 =====
function renderWbTasks(){
  const list=state.book==='short'?S_PIECES.map(p=>({no:p.no,name:'第'+p.no+'篇 · '+p.title,st:p.dot==='green'?'已定稿':p.dot==='yellow'?'草稿中':'待写',dot:p.dot})):CHAPTERS.map(c=>({no:Number(c.id.replace('ch','')),name:c.name,st:c.dot==='green'?'已定稿':c.dot==='yellow'?'草稿中':'待写',dot:c.dot}));
  el('wbtasks').innerHTML=list.map(t=>`<div class="wb-task ${state.wbChapter===t.no?'active':''}" data-no="${t.no}"><div class="tt"><span class="dot ${t.dot}"></span>${t.name}</div><div class="ts">${t.st}</div></div>`).join('');
  el('wbtasks').querySelectorAll('.wb-task').forEach(x=>x.onclick=()=>{state.wbChapter=+x.dataset.no;state.wbTextOut='';state.wbCheck='';state.wbReview='';state.wbVerdict=false;state.wbMsgs=MSGS.slice();state.wbHistOpen=true;renderWbTasks();renderWbMid();bindWb();renderWbCtx();renderStatus();});
}
function renderWbMid(){
  const c=el('content'),unit=state.book==='short'?'篇':'章';
  const stages=[['enter','进入'],['outline','细纲'],['confirm','确认'],['prepare','备料'],['draft','写稿'],['check','机检'],['review','审稿'],['finalize','定稿']];
  const idx=stages.findIndex(s=>s[0]===state.wbStage);
  const stageBar=stages.map((s,i)=>{
    const cls=i<idx?'done':i===idx?'active':'';
    return `<div class="stage ${cls}" data-stage="${s[0]}"><div class="s-node">${i<idx?'✓':s[1].charAt(0)}</div><div class="s-line"></div><div class="s-label">${s[1]}</div></div>`;
  }).join('');
  const outBody=state.wbTextOut?`<div class="wb-out">${state.wbTextOut}</div>`:'<div class="wb-out empty">（尚未生成 · 点「写稿」流式生成正文）</div>';
  const checkBody=state.wbCheck?`<div class="card"><div class="block-title">🔍 机检报告</div><pre class="report">${state.wbCheck}</pre></div>`:'';
  const reviewBody=state.wbReview?`<div class="card"><div class="block-title">📝 审稿单 ${state.wbVerdict?'<span class="tag green" style="margin-left:auto">已裁决通过</span>':'<span class="btn primary" id="wbVerdict" style="margin-left:auto">裁决通过 →</span>'}</div><pre class="report">${state.wbReview}</pre></div>`:'';
  const mainBody=state.cliOnline?`<div class="card"><div class="block-title">正文输出 ${state.wbRunning?'<span class="wb-live">● 流式</span>':''}</div>${outBody}</div>${checkBody}${reviewBody}`:`<div class="card"><div class="block-title">正文输出</div><div class="state-error"><div class="err-icon">🔌</div><div class="err-title">Claude CLI 连接中断</div><div class="err-desc">AI 步（细纲 / 写稿 / 三审）依赖 Claude CLI 子进程，当前无法连接；确定性步（确认 / 备料 / 机检 / 定稿）仍可用。请检查 CLI 运行状态后重试。</div><div class="err-meta">退出码 1 · 连接超时（mockup 演示）</div><span class="btn primary" id="wbRetry">↻ 重试连接</span></div></div>`;
  c.innerHTML=`<div class="content-scroll"><div class="bento-wrap" style="max-width:920px"><div class="bento-head"><h1 class="bento-title">工作台 · 第 ${state.wbChapter} ${unit}</h1><div class="bento-sub">${state.currentBookName} · 八阶段全接 · AI 步经 Claude CLI · 确定性步经 clwriting CLI</div></div><div class="state-card"><span class="state-tag">【写稿中】</span><span class="state-msg">第 ${state.wbChapter} ${unit} · 细纲已确认、备料就绪，spawnRole(writer) 流式输出中</span></div><div class="cc-banner">⚡ 八阶段全接 · AI 步（细纲/写稿/三审）经 Claude CLI，确定性步（确认/备料/机检/定稿）经 clwriting CLI</div><nav class="stages">${stageBar}</nav><div class="card ctrl"><div class="ctrl-row"><label>${unit}号 <input type="number" id="wbCh" value="${state.wbChapter}" min="1"></label><span class="btn-cli" data-cli="outline">${state.book==='short'?'📋 篇纲':'📋 细纲'}</span><span class="btn-cli" data-cli="confirm">✓ 确认</span><span class="btn-cli" data-cli="prepare">📦 备料</span><span class="btn-fire" id="wbDraft">${state.wbRunning?'写稿中…':'✍ 写第 '+state.wbChapter+' '+unit}</span>${state.wbRunning?'<span class="btn-stop" id="wbStop">⏹ 中断</span>':''}<span class="btn-cli" data-cli="check">🔍 机检</span><span class="btn-review" data-cli="review">📝 三审</span><span class="btn-cli ${state.wbVerdict?'':'disabled'}" data-cli="finalize">✅ 定稿</span><span class="btn" id="diffBtn">↔ 改写对比</span><label class="auto-toggle"><input type="checkbox" id="wbAuto" ${state.wbAuto?'checked':''}> 自动推进</label></div></div><div class="wb-main-2col">${renderWbTalk()}${mainBody}</div></div></div>`;
}
function renderWbCtx(){
  const sn=({outline:'细纲',confirm:'确认',prepare:'备料',draft:'写稿',check:'机检',review:'审稿',finalize:'定稿',enter:'进入'})[state.wbStage];
  el('wbctx').innerHTML=`<div class="card"><div class="card-title">任务详情</div><div class="kv"><span class="k">当前阶段</span><span class="v cyan">${sn}</span></div><div class="kv"><span class="k">${state.book==='short'?'篇':'章'}号</span><span class="v">${state.wbChapter}</span></div><div class="kv"><span class="k">驱动</span><span class="v">Claude CLI</span></div><div class="kv"><span class="k">预算</span><span class="v">$0.012 / $5</span></div><div class="kv"><span class="k">耗时</span><span class="v">38s</span></div></div><div class="card"><div class="card-title">事件流 <span style="color:var(--text-3);text-transform:none;font-weight:400">driver SSE</span></div>${state.wbEvents.length?state.wbEvents.map(e=>`<div class="ev ev-${e.cls}"><span class="ev-t">${e.t}</span><span class="ev-type">${e.type}</span><span class="ev-text">${e.text}</span></div>`).join(''):'<div class="hint">等待事件…</div>'}</div>`;
}
function wbPush(cls,type,text){state.wbEvents.push({t:new Date().toLocaleTimeString('zh-CN').slice(0,8),cls,type,text});if(state.wbEvents.length>40)state.wbEvents.shift();}
function wbCli(step){
  const labels={outline:'细纲',confirm:'确认',prepare:'备料',check:'机检',review:'三审',finalize:'定稿'};
  const unit=state.book==='short'?'篇':'章';
  state.wbStage=step;
  wbPush('spawn',(labels[step]||step)+' 第 '+state.wbChapter+' '+unit+'…');
  if(step==='outline')wbPush('saved',(state.book==='short'?'篇纲':'细纲')+'已生成 细纲/'+state.wbChapter+'.md (420 字)');
  else if(step==='check'){state.wbCheck='【机检报告】\n✓ 字数达标 2,100 / 2,000\n✓ 视角一致（林远）\n⚠ 第3段"忽然"重复 2 次，建议替换\n✓ 伏笔连续性 OK\n✓ 无逻辑断层';wbPush('saved','机检 ✓（见机检报告）');}
  else if(step==='review'){state.wbReview='【审稿单 · 三视角】\n\n## 镜头审\n节奏整体稳，第3章探索段略长，建议拆一句对话换拍。\n\n## 文字审\n"忽然/猛地"偏密（第4-5章），建议替换 2 处。\n\n## 连续性审\n赵衡袖中紧攥与后文呼应到位，人设无漂移。';wbPush('saved','三审 ✓ 视角：镜头/文字/连续性（见审稿单）');}
  else if(step==='finalize')wbPush('saved','定稿 ✓ 正文/'+state.wbChapter+'.md 已落盘（备份 ref 已建）');
  else wbPush('saved',(labels[step]||step)+' ✓');
  renderWbMid();renderWbCtx();
}
function wbDraft(){
  if(state.wbRunning)return;
  if(!state.cliOnline){showHint('Claude CLI 未连接 · 点状态栏或「重试」恢复');return;}
  state.wbRunning=true;state.wbTextOut='';state.wbStage='draft';state.wbCheck='';state.wbReview='';state.wbVerdict=false;
  wbPush('spawn','spawnRole(writer) · 第 '+state.wbChapter+' '+(state.book==='short'?'篇（含篇纲）':'章（含细纲+备料）'));
  renderWbMid();renderWbCtx();
  const sample=state.book==='short'?'　　凌晨一点的站台空荡荡，风从隧道深处灌上来，带着铁锈味。她照例走向最后一节车厢——这是她三年来，每个深夜的固定座位。\n　　邻座的人递来一张车票，她低头一看，日期印着十年前的今天。\n　　报站声响起，她浑身一震：「青石站」。那是个十年前就已拆除、她童年住过的小站。\n　　车停了。她终于想起，十年前那个雨夜，自己在站台上究竟等的是谁。':'　　夜色如墨。清虚山后山的禁地深处，一道极淡的微光从石壁裂缝中渗出，像是什么东西在里面缓慢地呼吸。\n　　三年了，林远第一次在这处历代弟子讳莫如深的石壁前，看见光。\n　　他屏住气，指尖不自觉抚上胸前那块温润的玉佩——父亲留下的唯一遗物。它从未有过异样，此刻却隔着衣衫隐隐发烫。\n　　「咔。」石壁应声缓缓移开。';
  let i=0;
  const timer=setInterval(()=>{
    state.wbTextOut=sample.slice(0,i);i+=Math.floor(Math.random()*8)+4;renderWbMid();
    if(i>=sample.length){clearInterval(timer);state.wbRunning=false;wbPush('done','完成 · 已落盘 工作区/草稿-'+state.wbChapter+'.md (186 字)');wbPush('usage','成本 $0.012 · 1,240 tokens');renderWbMid();renderWbCtx();if(state.wbAuto){showHint('写稿完成 · 自动推进 → 机检');setTimeout(()=>wbCli('check'),700);}}
  },120);
}
function nowStr(){return new Date().toLocaleTimeString('zh-CN').slice(0,5);}
// 指令与对话卡：作者意图输入 + 多轮对话历史（复用 .msg/.wb-input 样式与 MSGS 数据）
function renderWbTalk(){
  return `<div class="card wb-talk"><div class="block-title" style="display:flex;align-items:center;gap:8px;margin-bottom:8px">指令与对话 <span style="color:var(--text-3);text-transform:none;font-weight:400;font-size:11px">作者意图 → AI 改写</span><span class="tag" style="margin-left:auto">${state.wbMsgs.length} 轮</span><span class="wb-hist-toggle" id="wbToggleHist">${state.wbHistOpen?'收起 ▴':'展开 ▾'}</span></div>${state.wbHistOpen?`<div class="wb-msgs">${renderWbMsgs()}</div>`:''}<div class="wb-input"><input id="wbCmd" placeholder="告诉 AI 这章怎么写 / 怎么改…（回车发送）" autocomplete="off"><span class="btn primary" id="wbSend">发送</span></div></div>`;
}
function renderWbMsgs(){
  return state.wbMsgs.map(m=>{
    const head=`<div class="msg-head"><span>${m.name}</span><span style="color:var(--text-3);font-weight:400">${m.time}</span></div>`;
    let body=m.text?`<div class="msg-bubble">${m.text}</div>`:'';
    if(m.card)body+=`<div class="msg-card"><div class="mh">${m.card.summary}</div><pre>${m.card.draft}</pre></div>`;
    if(m.pending)body+=`<div class="wb-pending"><span class="btn primary">采纳并入正文</span><span class="btn">再改</span></div>`;
    return `<div class="msg ${m.role}">${head}${body}</div>`;
  }).join('');
}
function sendCmd(){
  const inp=el('wbCmd'),v=(inp&&inp.value||'').trim();
  if(!v)return;
  if(!state.cliOnline){showHint('Claude CLI 未连接 · 点状态栏或重试恢复');return;}
  state.wbMsgs.push({role:'user',name:'你',time:nowStr(),text:v});
  inp.value='';
  state.wbStage='draft';
  wbPush('spawn','driver 收到指令 · 按意图改写第 '+state.wbChapter+' '+(state.book==='short'?'篇':'章'));
  renderWbMid();bindWb();renderWbCtx();
  setTimeout(()=>{
    const draft='　　（据你的指令「'+v.slice(0,16)+(v.length>16?'…':'')+'」改写 · 玉佩反应更克制、悬念后置的版本。）';
    state.wbMsgs.push({role:'agent',name:'editor-agent',time:nowStr(),text:'已按「'+v.slice(0,12)+(v.length>12?'…':'')+'」调整，改写见正文输出区。',card:{summary:'改写 · 据指令 '+nowStr(),draft}});
    state.wbTextOut=draft;
    wbPush('saved','改写完成 · 已并入工作区草稿');
    renderWbMid();bindWb();renderWbCtx();
    showHint('已按指令改写 · 见正文输出');
  },900);
}
function bindWb(){
  const c=el('content');
  c.querySelectorAll('[data-stage]').forEach(s=>s.onclick=()=>{state.wbStage=s.dataset.stage;renderWbMid();renderWbCtx();renderStatus();});
  c.querySelectorAll('[data-cli]').forEach(b=>b.onclick=()=>wbCli(b.dataset.cli));
  const d=el('wbDraft');if(d)d.onclick=wbDraft;
  const dbtn=el('diffBtn');if(dbtn)dbtn.onclick=openDiff;
  const st=el('wbStop');if(st)st.onclick=()=>{state.wbRunning=false;wbPush('error','⏹ 已中断——正文已保留，可弃稿或改指令重写');renderWbMid();renderWbCtx();};
  const v=el('wbVerdict');if(v)v.onclick=()=>{state.wbVerdict=true;wbPush('saved','裁决：通过（可定稿）');renderWbMid();renderWbCtx();showHint('裁决通过 · 可定稿');};
  const rt=el('wbRetry');if(rt)rt.onclick=()=>{state.cliOnline=true;renderWbMid();renderWbCtx();renderStatus();bindWb();showHint('Claude CLI 已重连');};
  const a=el('wbAuto');if(a)a.onchange=()=>{state.wbAuto=a.checked;showHint('自动推进'+(a.checked?'已开':'已关'));};
  const send=el('wbSend');if(send)send.onclick=sendCmd;
  const cmd=el('wbCmd');if(cmd)cmd.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();sendCmd();}};
  const tg=el('wbToggleHist');if(tg)tg.onclick=()=>{state.wbHistOpen=!state.wbHistOpen;renderWbMid();bindWb();};
  const ch=el('wbCh');if(ch)ch.oninput=()=>{state.wbChapter=+ch.value||1;};
}

function toggleCli(){state.cliOnline=!state.cliOnline;renderStatus();if(state.mode==='workbench'){renderWbMid();bindWb();}showHint(state.cliOnline?'Claude CLI 已重连':'连接中断 · AI 步暂不可用（mockup 演示）');}
function renderStatus(){
  const cli=el('topbarCli');
  if(cli){cli.innerHTML='<span class="cli-dot"></span> '+(state.cliOnline?'Claude CLI':'未连接');cli.classList.toggle('off',!state.cliOnline);cli.onclick=toggleCli;}
}

// ===== 配置 modal =====
function applyCfg(){
  const r=document.documentElement.style;
  r.setProperty('--prose-font',state.cfgFont);
  r.setProperty('--prose-size',state.cfgSize+'px');
  r.setProperty('--prose-lh',state.cfgLh);
  r.setProperty('--prose-gap',state.cfgGap+'px');
  const prose=document.querySelector('.prose');
  if(prose){prose.style.fontFamily=state.cfgFont;prose.style.fontSize=state.cfgSize+'px';prose.style.lineHeight=state.cfgLh;}
  document.querySelectorAll('.prose p').forEach(p=>p.style.marginBottom=state.cfgGap+'px');
}
function renderConfig(){
  const SW={mono:['#f5f5f5','#1a1a1a']}
  el('cfgbody').innerHTML=`
    <div class="mb-section"><h3>主题</h3><div class="theme-grid">
      ${THEMES.map(t=>{const sw=SW[t[0]]||['#fff','#888'];return `<label class="swatch-row" data-th="${t[0]}"><input type="radio" name="th" value="${t[0]}" ${state.theme===t[0]?'checked':''} style="accent-color:var(--ink-cyan)"><div class="swatch" style="background:linear-gradient(135deg,${sw[0]},${sw[1]})"></div><div><div class="nm">${t[1]}</div><div class="ds">${t[2]}</div></div></label>`}).join('')}
    </div></div>
    <div class="mb-section"><h3>正文字体</h3>${[['STKaiti, 楷体, serif','楷体（系统，默认）'],['Songti SC, serif','宋体'],['LXGW WenKai, 楷体, serif','霞鹜文楷（需安装）'],["'Noto Serif SC', serif",'Noto 思源宋体']].map(f=>`<label class="swatch-row" style="margin-bottom:6px"><input type="radio" name="ft" value="${f[0]}" ${state.cfgFont===f[0]?'checked':''} style="accent-color:var(--ink-cyan)"><div class="nm" style="font-family:${f[0]}">${f[1]}</div></label>`).join('')}</div>
    <div class="mb-section"><h3>排版</h3>
      <div style="display:flex;flex-direction:column;gap:16px;padding:4px 0">
        <div><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px"><span style="color:var(--text-2)">字号</span><span style="color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums" id="cfgSizeVal">${state.cfgSize}</span></div><input type="range" id="cfgSize" min="12" max="24" step="0.5" value="${state.cfgSize}" style="width:100%;accent-color:var(--ink-cyan)"></div>
        <div><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px"><span style="color:var(--text-2)">行高</span><span style="color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums" id="cfgLhVal">${state.cfgLh}</span></div><input type="range" id="cfgLh" min="1.4" max="3.0" step="0.1" value="${state.cfgLh}" style="width:100%;accent-color:var(--ink-cyan)"></div>
        <div><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px"><span style="color:var(--text-2)">段间距</span><span style="color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums" id="cfgGapVal">${state.cfgGap}px</span></div><input type="range" id="cfgGap" min="8" max="32" step="2" value="${state.cfgGap}" style="width:100%;accent-color:var(--ink-cyan)"></div>
      </div>
    </div>
    <div class="mb-section"><h3>书库</h3><div class="kv"><span class="k">当前</span><span class="v">${currentLibLabel()}</span></div></div>
    <div class="mb-section"><h3>模型与驱动</h3><div class="kv"><span class="k">驱动</span><span class="v">Claude CLI 子进程</span></div><div class="kv"><span class="k">原则</span><span class="v">不直连大模型 · key 不入库</span></div></div>
    <div class="mb-section"><h3>快捷键</h3><div class="kv"><span class="k">⌘P</span><span class="v">命令面板</span></div><div class="kv"><span class="k">⌘B</span><span class="v">折叠侧栏</span></div><div class="kv"><span class="k">⌘⇧F</span><span class="v">专注模式</span></div></div>`;
  el('cfgbody').querySelectorAll('input[name=th]').forEach(r=>r.onchange=()=>{state.theme=r.value;applyTheme();showHint('已切换：'+(THEMES.find(x=>x[0]===r.value)||[])[1]);});
  el('cfgbody').querySelectorAll('input[name=ft]').forEach(r=>r.onchange=()=>{state.cfgFont=r.value;applyCfg();showHint('字体已切换');});
  const bindSlider=(id,key,unit,fmt)=>{const s=el(id),v=el(id+'Val');if(!s)return;s.oninput=()=>{state[key]=parseFloat(s.value);if(v)v.textContent=fmt?state[key]+unit:state[key];applyCfg();};};
  bindSlider('cfgSize','cfgSize','px',true);bindSlider('cfgLh','cfgLh','',false);bindSlider('cfgGap','cfgGap','px',true);
}
function openConfig(){renderConfig();el('cfgmask').classList.add('show');}
function closeConfig(){el('cfgmask').classList.remove('show');}
