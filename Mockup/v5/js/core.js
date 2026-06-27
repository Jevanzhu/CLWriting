
// ===== 核心逻辑 =====
// 数据在 data.js 中加载（全局作用域）
const state={view:'landing',mode:'edit',theme:'mono',book:'long',currentBookName:'观微',currentLibId:'lib_guanwei',file:'ch3',piece:1,ov:'o1',ledgerDetail:null,task:'t1',nbPhase:'form',nbName:'',nbGenre:'',nbKind:'long',nbTarget:'',nbBrief:'',nbLeads:[],nbSteps:[],nbLibId:'',wbStage:'draft',wbChapter:3,wbRunning:false,wbTextOut:'',wbCheck:'',wbReview:'',wbVerdict:false,wbAuto:true,wbEvents:[],foldL:false,focus:false,cfgFont:'STKaiti, 楷体, serif',cfgSize:17.5,cfgLh:2.0,cfgGap:16,loading:false,cliOnline:true,wbMsgs:MSGS.slice(),wbCmd:'',wbHistOpen:true,binderOpen:false,panelOpen:true};

const el=id=>document.getElementById(id);
function showHint(t){const h=el('hint');h.textContent=t;h.classList.add('show');clearTimeout(h._t);h._t=setTimeout(()=>h.classList.remove('show'),1700);}
function applyTheme(){document.documentElement.dataset.theme=state.theme;const tn=(THEMES.find(x=>x[0]===state.theme)||[])[1]||'';const tb=document.querySelector('[data-act=theme]');if(tb){tb.innerHTML='☾ '+tn;tb.title='主题：'+tn+'（点击切换）';}const m=el('cfgmask');if(m.classList.contains('show'))renderConfig();}
function P(cls,inner){return `<div class="${cls}">${inner}</div>`;}

// ===== 总渲染 =====
function currentLibLabel(){const l=LIBRARIES[0];return l?l.path:'~/CLWriting';}
function themeName(){return (THEMES.find(x=>x[0]===state.theme)||[])[1]||'';}
// 统一入口：按书名打开（设置当前书 + 模式 + 跳编辑态）
function openBookByName(name){
  const b=SHELF_BOOKS.find(s=>s.name===name);
  if(!b||b.demo)return;
  state.currentBookName=b.name;
  if(b.libId)state.currentLibId=b.libId;
  state.book=b.kind;
  state.file=b.kind==='short'?'sp1':'ch3';
  state.piece=1;
  state.mode='edit';
  state.ov=b.kind==='short'?'a_piece':'o1';
  state.ledgerDetail=null;
  state.view='book';
  render();
  showHint('已打开「'+b.name+'」');
}
function renderShelf(){
  const curLib=state.currentLibId||(LIBRARIES[0]?LIBRARIES[0].id:'');
  const oneLib=LIBRARIES.length<=1;
  const books=oneLib?SHELF_BOOKS:SHELF_BOOKS.filter(b=>b.libId===curLib);
  const real=books.filter(b=>!b.demo);
  const total=real.reduce((s,b)=>s+b.words,0);
  const lg=real.filter(b=>b.kind==='long').length,sh=real.length-lg;
  const longBooks=books.filter(b=>b.kind==='long'),shortBooks=books.filter(b=>b.kind==='short');
  const cardHtml=b=>{const wn=b.words>=10000?(b.words/10000).toFixed(1)+'万':b.words;const unit=b.kind==='short'?'篇':'章';const target=b.wordTarget||(b.kind==='short'?5000*b.chapters:30000);const pct=Math.min(Math.round(b.words/target*100),100);return `<div class="book-card ${b.demo?'demo':''}" data-book="${b.name}"><div class="bc-top"><span class="dot ${b.dot}"></span><span class="bc-name">${b.name}</span>${b.demo?'<span class="tag gray" style="margin-left:auto">示例</span>':''}</div><div class="bc-meta">${b.genre} · ${b.chapters} ${unit} · ${wn}字</div><div style="font-size:11px;color:var(--text-3);margin:4px 0 6px">${b.meta||''}</div><div class="progress" style="margin:6px 0 8px"><div style="width:${pct}%"></div></div><div class="bc-foot"><span>完成 ${pct}%</span><span>${b.updated}</span></div></div>`};
  const newCard=kind=>`<div class="shelf-new-card" data-kind="${kind}"><span class="plus">＋</span><span>新建${kind==='short'?'短篇集':'长篇'}</span></div>`;
  const section=(title,emoji,list,kind)=>`<div class="shelf-section"><div class="shelf-section-title">${emoji} ${title} <span class="cnt">${list.length} 本</span></div><div class="book-grid">${list.map(cardHtml).join('')}${newCard(kind)}</div></div>`;
  var libName=LIBRARIES.find(l=>l.id===curLib)?.name||'';
  return `<div class="shelf-inner"><div class="shelf-head"><div class="logo">墨</div><div><div class="shelf-title">书架</div><div style="color:var(--text-3);font-size:11px;letter-spacing:.5px">${libName?'· '+libName:''}</div></div><div class="shelf-sub" title="${currentLibLabel()}">${currentLibLabel()}</div><span class="btn" id="shOpen">📂 打开已有书库</span><span class="btn primary" id="shNew">+ 新建书</span></div><div class="bento-grid" style="margin:18px 0 24px"><div class="bento-card bento-lg"><div class="bc-menu">⋮</div><div class="bc-label">字数累计</div><div class="bc-stat">${total>=10000?(total/10000).toFixed(1)+'万':total}</div><div class="bc-bars">${real.map(b=>`<div class="bc-bar" style="height:${Math.max(b.words/(Math.max(...real.map(x=>x.words))||1)*100,4)}%" title="${b.name} · ${b.words}字"></div>`).join('')}</div><div class="bc-foot">${real.length} 本书 · 长篇 ${lg} · 短篇 ${sh} · 每根柱代表一本书</div></div><div class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">书本数</div><div class="bc-stat">${real.length}</div></div><div class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">长篇</div><div class="bc-stat">${lg}</div></div><div class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">短篇集</div><div class="bc-stat">${sh}</div></div><div class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">进行中</div><div class="bc-stat" style="color:var(--ink-cyan)">${real.filter(b=>b.dot==='green').length}</div></div></div><div class="shelf-sections">${section('长篇','📖',longBooks,'long')}${section('短篇集','📝',shortBooks,'short')}</div></div>`;
}
function bindShelf(){
  el('workspace').querySelectorAll('.book-card').forEach(c=>c.onclick=()=>{const n=c.dataset.book;if(c.classList.contains('demo')){showHint('《'+n+'》为示例占位 · 正文数据仅建模观微/夜行');return;}openBookByName(n);});
  const goNew=kind=>{state.nbKind=kind||'long';state.nbLibId=state.currentLibId||LIBRARIES[0]?.id;state.view='newbook';state.nbPhase='form';render();};
  const n=el('shNew'),o=el('shOpen');
  if(n)n.onclick=()=>goNew('long');
  el('workspace').querySelectorAll('.shelf-new-card').forEach(c=>c.onclick=()=>goNew(c.dataset.kind||'long'));
  if(o)o.onclick=()=>showHint('选择已有书库目录（mockup 演示 · 实际由桌面端 OS 文件对话框完成）');
}
function nbSampleResult(key,name,genre){
  const g=genre||'玄幻',n=name||'新书';
  const map={
    synopsis:`# ${n} · 总纲\n\n【题材】${g}\n【主线】少年崛起，解开身世之谜，对抗隐藏在秩序背后的古老势力。\n【基调】热血·成长·权谋交织。\n【预估】30-40 章，约 8-10 万字。`,
    characters:`# 角色档案\n\n## 主角 · 林远\n- 身份：清虚山外门弟子 / 玉佩传人\n- 性格：内敛坚韧，好奇心强\n- 弧光：解开父亲遗愿 → 直面禁忌\n## 重要配角\n- 赵衡：师兄，城府深，暗线人物`,
    world:`# 世界观\n\n大陆格局：九州十三派，清虚山为南方玄门之首。\n力量体系：灵气 → 修士 → 宗门秩序。\n禁忌：上古禁典、祖师秘辛。`,
    realm:`# 境界体系\n\n练气 → 筑基 → 金丹 → 元婴 → 化神 → 渡劫\n门槛：玉佩共鸣为觉醒之兆（主角线）。`,
    volume:`# 卷纲\n\n第一卷·入山觉醒（1-10章）：玉佩现世，禁典初露\n第二卷·禁典之争（11-20章）：旧案浮出，正面交锋\n第三卷·父亲遗愿（21-30章）：禁地真相，遗愿达成`,
    'leads-seed':`# 账本种子\n\n【伏笔】玉佩来历（父遗物，三年沉寂）\n【悬念】禁典内容（封皮仅余"禁"字）\n【关系债】赵衡旧案（讳莫如深）\n【设定线】境界门槛与禁典关联`,
    'style-sample':`# 文风样章\n\n　　清晨的清虚山笼着薄雾。少年背着旧布包，站在山门前，仰头看了许久。\n　　三年了，父亲的话仍压在心头。玉佩贴身收着，温润，却毫无动静。\n　　他不知道，自己即将撞进一桩被刻意掩埋的旧事里。`,
    'style-rules':`# 文风铁律\n\n1. 叙事克制，情绪靠动作和景物带出，禁直抒\n2. 每章末留钩子（悬念/反转/新信息）\n3. 对话简练，潜台词 > 明文\n4. 禁滥用"忽然/猛地"，动作要具体\n5. 场景切换用空行+景物，不用分隔符`,
    'style-quotes':`# 金句库\n\n- 「玉佩温的，是有人在想你。」\n- 「禁字不是禁人，是禁心。」\n- 「他等了三年，才明白等待本身就是答案。」\n- 「山门打开的那一刻，他回不了头了。」`,
    'collection-pitch':`# ${n} · 集子定位\n\n【题材】${g} 短篇集\n【主题】都市缝隙里的非常瞬间——每个故事都在日常褶皱里藏一次轻轻的失重\n【篇目规划】5-8 篇，每篇 4000-6000 字，独立成章\n【基调】克制·悬疑·余味`,
    'first-outline':`# 首篇细纲 · 末班车\n\n【目标情绪】孤独 → 释然\n【核心反转】末班车开往她亲手遗弃的站台\n【结构】\n1. 起深夜站台——她与末班车的日常契约\n2. 承陌生乘客——递来十年前的车票\n3. 转错站——报出已拆除的童年站名\n4. 合终站——她终于想起那个雨夜`,
  };
  return map[key]||`# ${key}\n\n（示例设定内容）`;
}
function renderNewbook(){return state.nbPhase==='form'?renderNbForm():renderNbOnboard();}
function renderNbForm(){
  const k=state.nbKind;
  const dir=k==='short'?['篇/NNN-标题/正文.md（每篇独立）','定稿/设定/（角色·境界·集子定位）','文风/（样章·铁律·金句，整集共享）','工作区/']:['定稿/正文/章号-标题.md（每章一文件）','大纲/（总纲·卷纲·账本类）','定稿/设定/（角色·境界·世界观）','文风/（样章·铁律·金句）','工作区/'];
  const leadsHtml=k==='long'?`<div class="sfield"><label>扩展账本</label><div class="nb-leads">${['局线','设定线','成长线','关系债'].map(l=>`<label class="nb-lead"><input type="checkbox" data-lead="${l}" ${state.nbLeads.includes(l)?'checked':''}><span>${l}</span></label>`).join('')}</div></div>`:'';
  return `<div class="shelf-inner" style="max-width:720px"><span class="btn" id="nbBack" style="margin-bottom:18px">← 返回</span><div class="shelf-title">新建书籍</div><div class="panel-sub" style="margin:6px 0 22px">所属书库：${state.nbLibId?(LIBRARIES.find(l=>l.id===state.nbLibId)||{}).name||LIBRARIES[0].name:LIBRARIES[0].name}</div><div class="card" style="padding:18px 20px"><div class="sfield"><label>书名 <span style="color:var(--cinnabar)">*</span></label><input id="nbName" placeholder="如：我的世界" value="${state.nbName}"></div><div class="sfield"><label>题材</label><input id="nbGenre" placeholder="如：玄幻 / 悬疑 / 言情（驱动账本推荐）" value="${state.nbGenre}"></div><div class="sfield"><label>类型</label><div class="seg"><button type="button" class="${k==='long'?'active':''}" data-kind="long">长篇</button><button type="button" class="${k==='short'?'active':''}" data-kind="short">短篇集</button></div></div><div class="sfield"><label>目标字数</label><input id="nbTarget" type="number" placeholder="如：300000（可选，算完成度）" value="${state.nbTarget}"></div><div class="sfield"><label>简介</label><textarea id="nbBrief" rows="3" placeholder="一两句话讲清这本书讲什么、主角是谁、核心看点">${state.nbBrief}</textarea></div><div class="sfield"><label>目录</label><pre class="dir-preview">${dir.join('\n')}</pre></div>${leadsHtml}<div class="sfield"><label>AI 宿主</label><div class="nb-host"><span class="host-on">⚡ Claude Code (cc)</span><span class="host-off" title="首版暂不支持">Codex（暂未支持）</span></div></div></div><div class="btn-row" style="justify-content:flex-end"><span class="btn primary" id="nbSubmit">创建 → 进段 2</span></div></div>`;
}
function renderNbOnboard(){
  const k=state.nbKind;
  const defs=k==='short'?[['collection-pitch','📋 集子定位'],['first-outline','📝 首篇细纲'],['style-sample','✍️ 文风样章'],['style-rules','📜 文风铁律'],['style-quotes','💎 金句库']]:[['synopsis','📋 总纲'],['characters','👥 角色'],['world','🌍 世界观'],['realm','⚡ 境界体系'],['volume','📚 卷纲'],['leads-seed','🎯 账本种子'],['style-sample','✍️ 文风样章'],['style-rules','📜 文风铁律'],['style-quotes','💎 金句库']];
  if(state.nbSteps.length!==defs.length)state.nbSteps=defs.map(d=>({key:d[0],label:d[1],status:'todo',result:''}));
  return `<div class="shelf-inner" style="max-width:780px"><span class="btn" id="nbBack2" style="margin-bottom:18px">← 返回书架</span><div class="shelf-title">段 2 · AI 填设定</div><div class="panel-sub" style="margin:6px 0 22px">《${state.nbName||'未命名'}》已创建 · 让 AI 据题材填设定（每步可生成 / 编辑 / 重生成 / 跳过）</div>${state.nbSteps.map((s,i)=>renderNbStep(s,i)).join('')}<div class="btn-row" style="justify-content:flex-end"><span class="btn primary" id="nbFinish">完成 → 进单书</span></div></div>`;
}
function renderNbStep(s,i){
  const stCls=s.status==='done'?'green':s.status==='skip'?'gray':'';
  const stTxt=s.status==='done'?'已生成':s.status==='skip'?'已跳过':'待处理';
  const ops=`<div class="step-ops"><span class="btn" data-gen="${i}">${s.status==='done'?'🔄 重生成':'⚡ 生成'}</span>${s.status==='skip'?`<span class="btn" data-restore="${i}">恢复</span>`:s.status==='todo'?`<span class="btn" data-skip="${i}">⏭ 跳过</span>`:''}</div>`;
  const body=s.status==='done'?`<textarea class="result-edit" rows="6" data-step="${i}">${s.result}</textarea><div class="step-foot"><span class="result-path">设定/${s.label.replace(/^.{1,2}\s/,'')}.md · ${s.result.replace(/\s/g,'').length} 字</span><span class="btn primary" data-save="${i}">💾 保存编辑</span></div>`:'';
  return `<div class="card nb-step ${s.status==='skip'?'skipped':''}"><div class="step-head"><span class="step-label">${s.label}</span><span class="tag ${stCls}">${stTxt}</span>${ops}</div>${body}</div>`;
}
function bindNewbook(){
  if(state.nbPhase==='form'){
    el('nbBack').onclick=()=>{state.view='shelf';render();};
    el('nbName').oninput=e=>state.nbName=e.target.value;
    el('nbGenre').oninput=e=>state.nbGenre=e.target.value;
    el('nbTarget').oninput=e=>state.nbTarget=e.target.value;
    el('nbBrief').oninput=e=>state.nbBrief=e.target.value;
    el('workspace').querySelectorAll('[data-kind]').forEach(b=>b.onclick=()=>{state.nbKind=b.dataset.kind;render();});
    el('workspace').querySelectorAll('[data-lead]').forEach(c=>c.onchange=()=>{const l=c.dataset.lead;const i=state.nbLeads.indexOf(l);if(i>=0)state.nbLeads.splice(i,1);else state.nbLeads.push(l);});
    el('nbSubmit').onclick=()=>{if(!state.nbName.trim()){showHint('请填书名');return;}state.nbPhase='onboard';state.nbSteps=[];render();showHint('《'+state.nbName.trim()+'》已创建 · 进段 2');};
  }else{
    el('nbBack2').onclick=()=>{state.view='shelf';render();};
    el('workspace').querySelectorAll('[data-gen]').forEach(b=>b.onclick=()=>{const i=+b.dataset.gen;const s=state.nbSteps[i];s.status='done';s.result=nbSampleResult(s.key,state.nbName.trim(),state.nbGenre.trim());render();showHint(s.label+' 已生成（示例）');});
    el('workspace').querySelectorAll('[data-skip]').forEach(b=>b.onclick=()=>{state.nbSteps[+b.dataset.skip].status='skip';render();});
    el('workspace').querySelectorAll('[data-restore]').forEach(b=>b.onclick=()=>{state.nbSteps[+b.dataset.restore].status='todo';render();});
    el('workspace').querySelectorAll('[data-save]').forEach(b=>b.onclick=()=>showHint('已保存（mockup 演示）'));
    el('workspace').querySelectorAll('.result-edit').forEach(t=>t.oninput=()=>{state.nbSteps[+t.dataset.step].result=t.value;});
    el('nbFinish').onclick=()=>{var book={name:state.nbName.trim(),kind:state.nbKind,genre:state.nbGenre||'未分类',words:0,chapters:state.nbKind==='short'?0:1,wordTarget:state.nbTarget||(state.nbKind==='short'?25000:80000),dot:'gray',updated:'刚刚',meta:state.nbKind==='short'?'短篇集 · 待开稿':'长篇 · 待开稿',libId:state.nbLibId||LIBRARIES[0]?.id,demo:false};SHELF_BOOKS.push(book);state.currentBookName=book.name;state.view='book';state.book=state.nbKind;state.file=state.nbKind==='short'?'sp1':'ch3';state.piece=1;state.mode='edit';state.ov=state.nbKind==='short'?'a_piece':'o1';render();showHint('《'+state.nbName.trim()+'》已创建 · 进单书');};
  }
}
function render(){
  if(state.ov!=='a_relations')relSel=null;
  const ws=el('workspace');
  const tb=document.querySelector('.topbar');
  const ss=el('siderSlot');
  const _mt0=document.querySelector('.mode-tabs');
  if(_mt0)_mt0.style.display=state.view==='book'?'flex':'none';
  el('wcTitle').textContent='CLWriting Studio';
  renderStatus(); // topbarCli 已移至 window-chrome（常驻），每次渲染刷新徽章
  if(state.view==='landing'){tb.style.display='none';ss.style.display='none';ss.innerHTML='';ws.className='workspace full';ws.innerHTML=renderLanding();bindLanding();el('statusbar').innerHTML='<span class="host">● Claude CLI 已连接</span><span>启动页 · '+currentLibLabel()+'</span><div class="right"><span>'+themeName()+'</span></div>';return;}
  if(state.view==='libraries'){tb.style.display='none';ss.style.display='none';ss.innerHTML='';ws.className='workspace full';ws.innerHTML=renderLibraries();bindLibraries();el('statusbar').innerHTML='<span class="host">● Claude CLI 已连接</span><span>书库 · '+LIBRARIES.length+' 个</span><div class="right"><span>'+themeName()+'</span></div>';return;}
  if(state.view==='shelf'){tb.style.display='none';ss.style.display='none';ss.innerHTML='';ws.className='workspace full';ws.innerHTML=renderShelf();bindShelf();el('statusbar').innerHTML='<span class="host">● Claude CLI 已连接</span><span>书架 · 共 '+SHELF_BOOKS.length+' 本 · '+currentLibLabel()+'</span><div class="right"><span>'+themeName()+'</span></div>';return;}
  if(state.view==='newbook'){tb.style.display='none';ss.style.display='none';ss.innerHTML='';ws.className='workspace full';ws.innerHTML=renderNewbook();bindNewbook();el('statusbar').innerHTML='<span class="host">● Claude CLI 已连接</span><span>建书 · '+(state.nbPhase==='form'?'段 1 表单':'段 2 AI 填设定')+'</span><div class="right"><span>'+themeName()+'</span></div>';return;}
  if(state.view!=='book')return;
  tb.style.display='';
  ss.style.display='';
  const _b=SHELF_BOOKS.find(s=>s.name===state.currentBookName)||{};
  const _wn=(_b.words||0)>=10000?((_b.words||0)/10000).toFixed(1)+'万':(_b.words||0);
  el('wcTitle').innerHTML='<span class="wt-name">'+state.currentBookName+'</span><span class="wt-sep">·</span><span class="wt-meta">'+(state.book==='short'?'短篇集':'长篇')+'</span><span class="wt-sep">·</span><span class="wt-meta">'+_wn+'字</span>';
  ws.className='workspace'+(state.focus&&state.mode==='edit'?' focus':'')+(state.panelOpen?'':' panel-closed');
  tb.className='topbar';
  ss.className='sider-slot'+(state.focus&&state.mode==='edit'?' focus':'')+(state.foldL?' fold-l':'');
  if(state.mode==='edit'){
    ss.innerHTML=P('sider-left','<div class="book-anchor">'+bookAnchorInner()+'</div><div class="sider-scroll"><div class="tree" id="tree"></div><div class="binder" id="binder"></div></div><div class="sider-foot"><div class="foot-back" id="shelfBtn" title="返回书架"><span class="foot-arrow">←</span><span>书架</span></div><div class="icon-btn" id="footSettings" data-act="settings" title="设置">⋯</div><div class="kind-seg" id="kindSeg"></div></div>');
    ws.innerHTML='<div class="main-area"><main class="content" id="content"></main>'+
      P('sider-right','<div class="sider-right-head"><div class="sr-head-left"><span class="sr-eyebrow">详情</span><span class="sr-title">'+state.currentBookName+'</span></div><span class="sr-close" id="panelClose" title="收起">✕</span></div><div class="sider-right-inner" id="rightctx"></div>')+'</div>';
    renderBinder();renderTree();renderFileMid();applyCfg();renderEditRight();renderStatus();
  }else if(state.mode==='overview'){
    ss.innerHTML=P('sider-left','<div class="book-anchor">'+bookAnchorInner()+'</div><div class="sider-scroll"><div class="tree" id="ovnav"></div><div class="binder" id="binder"></div></div><div class="sider-foot"><div class="foot-back" id="shelfBtn" title="返回书架"><span class="foot-arrow">←</span><span>书架</span></div><div class="icon-btn" id="footSettings" data-act="settings" title="设置">⋯</div><div class="kind-seg" id="kindSeg"></div></div>');
    ws.innerHTML='<div class="main-area"><main class="content" id="content"></main>'+
      P('sider-right','<div class="sider-right-head"><div class="sr-head-left"><span class="sr-eyebrow">详情</span><span class="sr-title">'+state.currentBookName+'</span></div><span class="sr-close" id="panelClose" title="收起">✕</span></div><div class="sider-right-inner" id="rightctx"></div>')+'</div>';
    renderBinder();renderOvNav();renderOvMid();applyCfg();renderOvRight();renderStatus();
  }else{
    ss.innerHTML=P('wb-list','<div class="book-anchor">'+bookAnchorInner()+'</div><div class="sider-scroll"><div class="tree-head"><span class="tree-head-label">任务</span><span class="head-count">'+(state.book==='short'?S_PIECES.length:CHAPTERS.length)+'</span></div><div class="wb-tasks" id="wbtasks"></div><div class="binder" id="binder"></div></div><div class="sider-foot"><div class="foot-back" id="shelfBtn" title="返回书架"><span class="foot-arrow">←</span><span>书架</span></div><div class="icon-btn" id="footSettings" data-act="settings" title="设置">⋯</div><div class="kind-seg" id="kindSeg"></div></div>');
    ws.innerHTML='<div class="main-area"><main class="content" id="content"></main>'+
      P('sider-right','<div class="sider-right-head"><div class="sr-head-left"><span class="sr-eyebrow">详情</span><span class="sr-title">'+state.currentBookName+'</span></div><span class="sr-close" id="panelClose" title="收起">✕</span></div><div class="sider-right-inner" id="wbctx"></div>')+'</div>';
    renderBinder();renderWbTasks();renderWbMid();renderWbCtx();renderStatus();
    bindWb();
  }
  renderKindSeg();
  document.querySelectorAll('.mode-tab').forEach(t=>t.classList.toggle('active',t.dataset.mode===state.mode));
  const pc=el('panelClose');if(pc)pc.onclick=()=>{state.panelOpen=false;render();};
  const sb=el('shelfBtn');if(sb)sb.onclick=()=>{state.view='shelf';render();};
  // 右栏跟随中栏(content-scroll)滚动
  const _cs=document.querySelector('.content-scroll'),_ri=document.querySelector('.sider-right-inner');
  if(_cs&&_ri)_cs.onscroll=()=>{_ri.scrollTop=_cs.scrollTop;};
  const _fs=el('footSettings');if(_fs)_fs.onclick=openConfig;
  // 右栏顶部对齐中栏第一张卡片（编辑器/便当盒卡片）——跨层级垂直对齐，CSS 做不到
  const alignRight=()=>{
    const card=document.querySelector('.content-scroll .bento-card, .content-scroll .editor-inner');
    const sr=document.querySelector('.sider-right'),ws=document.querySelector('.workspace');
    if(card&&sr&&ws) sr.style.top=Math.max(0,card.getBoundingClientRect().top-ws.getBoundingClientRect().top)+'px';
  };
  alignRight();
  // editor 居中【左右栏间隙中心】（两侧栏宽度可能不等）+ 抵消滚动条占右侧 sw；
  // 字体异步加载会改变 editor 高度 → 滚动条出现/消失，故 fonts.ready 后重跑一次
  const fixScroll=()=>{
    const cs=document.querySelector('.content-scroll');if(!cs)return;
    const sw=cs.offsetWidth-cs.clientWidth,pr=40;
    const sl=document.querySelector('.sider-slot'),sr=document.querySelector('.sider-right');
    let pl=pr+sw;
    if(sl&&sr){const shift=((sl.getBoundingClientRect().right+sr.getBoundingClientRect().left)/2)-(cs.getBoundingClientRect().left+cs.offsetWidth/2);pl=pr+sw+Math.round(2*shift);}
    cs.style.paddingLeft=pl+'px';cs.style.paddingRight=pr+'px';
  };
  fixScroll();
  if(!render._arBound){window.addEventListener('resize',()=>{alignRight();fixScroll();});render._arBound=true;}
}

// ===== 左栏顶部：书名锚点 =====
function bookAnchorInner(){
  const b=SHELF_BOOKS.find(s=>s.name===state.currentBookName)||{};
  const w=b.words||0,t=b.wordTarget||(state.book==='short'?25000:80000);
  const pct=Math.min(Math.round(w/t*100),100);
  const wn=w>=10000?(w/10000).toFixed(1)+'万':w;
  return `<div class="ba-name">${state.currentBookName}</div><div class="ba-meta">${b.genre||'未分类'} · ${wn}字 · ${pct}%</div><div class="ba-bar"><div style="width:${pct}%"></div></div>`;
}
// ===== 左栏 binder：书列表（只列当前类型）=====
function renderBinder(){
  const list=SHELF_BOOKS.filter(b=>b.kind===state.book);
  const kindLabel=state.book==='short'?'短篇集':'长篇';
  let html='<div class="binder-head"><span>书籍</span><span class="head-count">'+list.length+'</span></div>';
  if(!list.length)html+='<div class="binder-empty">暂无'+kindLabel+'书籍</div>';
  else html+='<div class="binder-items">'+list.map(b=>`<div class="binder-item ${b.name===state.currentBookName?'active':''} ${b.demo?'demo':''}" data-book="${b.name}"><span class="dot ${b.dot}"></span><span class="bi-name">${b.name}</span>${b.demo?'<span class="tag mini">示例</span>':''}</div>`).join('')+'</div>';
  el('binder').innerHTML=html;
  el('binder').querySelectorAll('.binder-item').forEach(it=>it.onclick=()=>{const n=it.dataset.book;const b=SHELF_BOOKS.find(s=>s.name===n);if(b&&b.demo){showHint('《'+n+'》为示例占位 · 正文数据仅建模观微/夜行');return;}openBookByName(n);});
}
// 类型切换 segmented（长篇 / 短篇集）：切到该类型第一本可开书
function renderKindSeg(){
  const cur=state.book;
  const opts=[['long','长篇'],['short','短篇集']];
  const curOpt=opts.find(o=>o[0]===cur)||opts[0];
  const kg=el('kindSeg');
  if(!kg)return;
  kg.innerHTML=`<div class="kind-drop"><span class="caret"><i class="up"></i><i class="dn"></i></span><span>${curOpt[1]}</span></div><div class="kind-menu">${opts.map(([k,label])=>`<div class="kind-item ${k===cur?'active':''}" data-kind="${k}"><span>${label}</span>${k===cur?'<span class="km-check">✓</span>':''}</div>`).join('')}</div>`;
  kg.querySelector('.kind-drop').onclick=(e)=>{e.stopPropagation();kg.classList.toggle('open');};
  kg.querySelectorAll('.kind-item').forEach(it=>it.onclick=(e)=>{e.stopPropagation();kg.classList.remove('open');const k=it.dataset.kind;const book=SHELF_BOOKS.find(s=>s.kind===k&&!s.demo);if(book)openBookByName(book.name);else showHint(k==='short'?'暂无可开的短篇集':'暂无可开的长篇');});
  if(!renderKindSeg._bound){document.addEventListener('click',()=>document.querySelectorAll('.kind-seg.open').forEach(x=>x.classList.remove('open')));renderKindSeg._bound=true;}
}
