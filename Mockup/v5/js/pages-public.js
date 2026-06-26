
// ===== ⌘P 命令面板 =====
function cmdGroups(){
  // 文件操作组按当前书类型动态生成（长篇=章，短篇=篇）
  const fileItems=state.book==='short'?[
    {name:'跳到第1篇 · 末班车',desc:'sp1',key:'',action:()=>{state.mode='edit';state.file='sp1';render();closeCmd();}},
    {name:'跳到第2篇 · 夜班',desc:'sp2',key:'',action:()=>{state.mode='edit';state.file='sp2';render();closeCmd();}},
    {name:'跳到第3篇 · 镜中人',desc:'sp3',key:'',action:()=>{state.mode='edit';state.file='sp3';render();closeCmd();}},
    {name:'打开集子总纲',desc:'outline',key:'',action:()=>{state.mode='edit';state.file='sg_ol';render();closeCmd();}},
    {name:'打开世界观设定',desc:'setting',key:'',action:()=>{state.mode='edit';state.file='ss_city';render();closeCmd();}},
  ]:[
    {name:'跳到第1章 · 初入山门',desc:'ch1',key:'',action:()=>{state.mode='edit';state.file='ch1';render();closeCmd();}},
    {name:'跳到第3章 · 禁典残卷',desc:'ch3',key:'',action:()=>{state.mode='edit';state.file='ch3';render();closeCmd();}},
    {name:'跳到第5章 · 师兄异动',desc:'ch5',key:'',action:()=>{state.mode='edit';state.file='ch5';render();closeCmd();}},
    {name:'打开总纲（大纲）',desc:'outline',key:'',action:()=>{state.mode='edit';state.file='ol_main';render();closeCmd();}},
    {name:'打开境界体系设定',desc:'setting',key:'',action:()=>{state.mode='edit';state.file='sr_realm';render();closeCmd();}},
  ];
  return [
   {group:'导航',items:[
    {name:'切换到编辑态',desc:'edit',key:'⌘E',action:()=>{state.mode='edit';render();closeCmd();}},
    {name:'切换到总览态',desc:'overview',key:'⌘O',action:()=>{state.mode='overview';render();closeCmd();}},
    {name:'切换到工作台',desc:'workbench',key:'⌘W',action:()=>{state.mode='workbench';render();closeCmd();}},
    {name:'打开设置',desc:'settings',key:'⌘,',action:()=>{openConfig();closeCmd();}},
    {name:'专注模式',desc:'focus',key:'⌘⇧F',action:()=>{state.focus=!state.focus;if(state.focus)state.mode='edit';render();closeCmd();}},
   ]},
   {group:'文件操作',items:fileItems},
   {group:'视图',items:[
    {name:'作品概要',desc:'overview',key:'',action:()=>{state.mode='overview';state.ov='o1';render();closeCmd();}},
    {name:'字数统计',desc:'overview',key:'',action:()=>{state.mode='overview';state.ov='o2';render();closeCmd();}},
    {name:'体检',desc:'overview',key:'',action:()=>{state.mode='overview';state.ov='a_health';render();closeCmd();}},
    {name:'账本',desc:'overview',key:'',action:()=>{state.mode='overview';state.ov='a_ledger';render();closeCmd();}},
    {name:'篇详情',desc:'piece',key:'',action:()=>{state.mode='overview';state.ov='a_piece';state.piece=1;render();closeCmd();}},
   ]},
   {group:'主题',items:THEMES.map(t=>({name:'主题：'+t[1],desc:t[2],key:'',action:()=>{state.theme=t[0];applyTheme();renderStatus();closeCmd();showHint('已切换：'+t[1]);}}))},
   {group:'书籍',items:SHELF_BOOKS.filter(b=>!b.demo).map(b=>({name:b.name,desc:b.genre,key:'',action:()=>{openBookByName(b.name);closeCmd();}}))},
  ];
}
let cmdSel=0,cmdFiltered=[];
function openCmd(){el('cmdMask').classList.add('show');const inp=el('cmdInput');inp.value='';cmdSel=0;renderCmdList('');setTimeout(()=>inp.focus(),50);}
function closeCmd(){el('cmdMask').classList.remove('show');}
function renderCmdList(q){
  const ql=q.toLowerCase();let idx=0;
  cmdFiltered=[];
  let html='';
  cmdGroups().forEach(g=>{
    const match=g.items.filter(it=>!ql||it.name.toLowerCase().includes(ql)||(it.desc||'').toLowerCase().includes(ql));
    if(!match.length)return;
    html+='<div class="cmd-group-label">'+g.group+'</div>';
    match.forEach(it=>{cmdFiltered.push(it);const sel=idx===cmdSel?'sel':'';html+='<div class="cmd-item '+sel+'" data-ci="'+idx+'"><span class="cmd-name">'+it.name+'</span>'+(it.key?'<span class="cmd-shortcut">'+it.key+'</span>':'')+'</div>';idx++;});
  });
  if(!cmdFiltered.length)html='<div class="cmd-empty">无匹配命令</div>';
  el('cmdList').innerHTML=html;
  el('cmdList').querySelectorAll('.cmd-item').forEach(x=>x.onclick=()=>{const i=+x.dataset.ci;cmdFiltered[i].action();});
}
el('cmdInput').addEventListener('input',e=>{cmdSel=0;renderCmdList(e.target.value);});
el('cmdInput').addEventListener('keydown',e=>{
  if(e.key==='ArrowDown'){e.preventDefault();cmdSel=Math.min(cmdSel+1,cmdFiltered.length-1);renderCmdList(el('cmdInput').value);}
  else if(e.key==='ArrowUp'){e.preventDefault();cmdSel=Math.max(cmdSel-1,0);renderCmdList(el('cmdInput').value);}
  else if(e.key==='Enter'){e.preventDefault();if(cmdFiltered[cmdSel])cmdFiltered[cmdSel].action();}
  else if(e.key==='Escape'){closeCmd();}
});
el('cmdMask').onclick=e=>{if(e.target===el('cmdMask'))closeCmd();};
document.querySelector('[data-act=cmd]').onclick=openCmd;

// ===== 改写 + diff 视图 =====
function openDiff(){
  const oldText='　　夜色如墨。清虚山后山的禁地深处，一道极淡的微光从石壁裂缝中渗出，像是什么东西在里面缓慢地呼吸。三年了，林远第一次在这处历代弟子讳莫如深的石壁前，看见光。\n　　他屏住气，指尖不自觉抚上胸前那块温润的玉佩——父亲留下的唯一遗物。它从未有过异样，此刻却隔着衣衫隐隐发烫。\n　　「咔。」石壁应声缓缓移开。';
  const newText='　　石壁的裂口不大，光却极韧。\n　　林远往前半步，玉佩的热度突然收敛了——不是凉，是沉，像被什么东西按了一下，沉进胸口。他低头看，那枚跟了三年的玉，表面浮着一层极淡的纹路，像水痕，又像什么他看不懂的字。\n　　裂口里传出极轻的摩擦声。';
  const oldLines=oldText.split('\n'),newLines=newText.split('\n');
  const diffHtml=(lines,sign)=>lines.map(l=>'<div class="diff-line '+sign+'">'+(l||' ')+'</div>').join('');
  el('diffBody').innerHTML='<div class="diff-pane"><h4>原始文本 <span class="tag red">旧</span></h4>'+diffHtml(oldLines,'del')+'</div><div class="diff-pane"><h4>AI 改写 <span class="tag green">新</span></h4>'+diffHtml(newLines,'add')+'</div>';
  el('diffMask').classList.add('show');
}
function closeDiff(){el('diffMask').classList.remove('show');}
el('diffClose').onclick=closeDiff;
el('diffMask').onclick=e=>{if(e.target===el('diffMask'))closeDiff();};
el('diffAccept').onclick=()=>{showHint('已采纳改写 · 正文已更新');closeDiff();};
el('diffKeep').onclick=()=>{showHint('保留旧版');closeDiff();};
el('diffCancel').onclick=closeDiff;

// ===== 回滚 · 历史版本 =====
// 取当前编辑对象（章 / 篇），用于读取/回写正文
function currentDoc(){
  const F=state.book==='short'?S_FILES:FILES;
  const f=F.find(x=>x.id===state.file);
  if(!f)return null;
  if(f.type==='piece')return S_PIECES.find(p=>p.no===f.no);
  if(!f.type||f.type==='chapter')return CHAPTERS.find(c=>c.id===state.file)||CHAPTERS[0];
  return null;
}
let revSel=0;
function openRevert(){
  const vs=getVersions(state.file);
  revSel=vs.findIndex(v=>!v.cur);if(revSel<0)revSel=0;
  const F=state.book==='short'?S_FILES:FILES;
  const f=F.find(x=>x.id===state.file)||{};
  el('revTitle').textContent='历史版本 · '+(f.name||'当前文件');
  renderRev();
  el('revMask').classList.add('show');
}
function renderRev(){
  const vs=getVersions(state.file);
  const list=vs.map((v,i)=>{const dc=v.diff.startsWith('-')?'neg':(v.diff!=='+0'&&v.diff.startsWith('+'))?'pos':'zero';return `<div class="rev-item ${i===revSel?'active':''}" data-ri="${i}"><div class="ri-top"><span class="ri-label">${v.label}</span><span class="ri-diff ${dc}">${v.diff}</span>${v.cur?'<span class="ri-cur">当前</span>':''}</div><div class="ri-time">${v.t}<span class="ri-ref">· ${v.ref}</span></div><div class="ri-note">${v.note}</div></div>`;}).join('');
  const sel=vs[revSel]||vs[0];
  const doc=currentDoc();
  const curText=doc&&doc.prose?doc.prose.join('\n'):'';
  let preview;
  if(sel.text){
    const dh=(lines,sign)=>lines.map(l=>'<div class="diff-line '+sign+'">'+(l||' ')+'</div>').join('');
    preview=`<div class="rp-head">已选 · ${sel.label} <span class="tag gray">${sel.ref}</span> <span class="tag">${sel.diff}</span></div><div class="diff-body"><div class="diff-pane"><h4>历史版本 <span class="tag red">将恢复</span></h4>${dh(sel.text.split('\n'),'del')}</div><div class="diff-pane"><h4>当前版本 <span class="tag green">现稿</span></h4>${dh(curText.split('\n'),'add')}</div></div>`;
  }else{
    preview=`<div class="rp-head">已选 · ${sel.label} <span class="tag gray">${sel.ref}</span></div><div class="rp-empty">📄<span>该版本暂无正文快照</span><span style="font-size:11px">（mockup · 仅 ch3 / 第1篇 建模了完整历史）</span></div>`;
  }
  el('revBody').innerHTML=`<div class="rev-list">${list}</div><div class="rev-preview">${preview}</div>`;
  el('revBody').querySelectorAll('.rev-item').forEach(x=>x.onclick=()=>{revSel=+x.dataset.ri;renderRev();});
  const rst=el('revRestore'),isCur=vs[revSel]&&vs[revSel].cur;
  rst.style.opacity=isCur?'.4':'1';rst.style.pointerEvents=isCur?'none':'auto';rst.textContent=isCur?'已是当前版':'恢复此版';
}
function closeRevert(){el('revMask').classList.remove('show');}
el('revClose').onclick=closeRevert;
el('revCancel').onclick=closeRevert;
el('revMask').onclick=e=>{if(e.target===el('revMask'))closeRevert();};
el('revRestore').onclick=()=>{const vs=getVersions(state.file),v=vs[revSel];if(!v)return;const doc=currentDoc();if(v.text&&doc){doc.prose=v.text.split('\n');doc.words=v.text.replace(/\s/g,'').length;}closeRevert();renderFileMid();renderEditRight();renderStatus();showHint('已恢复到「'+v.label+'」· ref '+v.ref+'（mockup 演示）');};

// ===== 事件 =====
document.querySelectorAll('.mode-tab').forEach(t=>t.onclick=()=>{state.mode=t.dataset.mode;render();});
document.querySelector('[data-act=theme]').onclick=()=>{const order=THEMES.map(x=>x[0]);const i=order.indexOf(state.theme);state.theme=order[(i+1)%order.length];applyTheme();renderStatus();showHint('已切换：'+(THEMES.find(x=>x[0]===state.theme)||[])[1]);};
document.querySelector('[data-act=settings]').onclick=openConfig;
el('cfgclose').onclick=closeConfig;
el('cfgmask').onclick=e=>{if(e.target===el('cfgmask'))closeConfig();};
document.querySelector('[data-act=focus]').onclick=()=>{state.focus=!state.focus;if(state.focus)state.mode='edit';render();showHint(state.focus?'专注模式 · 编辑框独占（再按 ⌘⇧F 退出）':'已退出专注');};
document.querySelector('[data-act=panel]').onclick=()=>{state.panelOpen=!state.panelOpen;render();showHint(state.panelOpen?'已展开详情面板':'已收起详情面板');};
document.addEventListener('keydown',e=>{const cmd=e.metaKey||e.ctrlKey;if(!cmd)return;const k=e.key.toLowerCase();if(k==='b'){e.preventDefault();state.foldL=!state.foldL;render();showHint(state.foldL?'已折叠侧栏（⌘B 展开）':'已展开侧栏');}else if(k==='f'&&e.shiftKey){e.preventDefault();state.focus=!state.focus;if(state.focus)state.mode='edit';render();showHint(state.focus?'专注模式 · 编辑框独占':'已退出专注');}else if(k==='p'){e.preventDefault();if(el('cmdMask').classList.contains('show'))closeCmd();else openCmd();}});

// ===== 启动页 =====
function renderLanding(){
  var recentLibs=LIBRARIES.slice(0,2);
  var recentBooks=SHELF_BOOKS.filter(function(b){return !b.demo;}).slice(0,4);
  var libCards=recentLibs.map(function(l){return '<div class="landing-card lib-card" data-lid="'+l.id+'"><div class="lc-icon long">书</div><div class="lc-info"><div class="lc-name">'+l.name+'</div><div class="lc-meta">'+l.path+'</div></div><div class="lc-badge">书库</div></div>';}).join('');
  var bookCards=recentBooks.map(function(b){var icon=b.kind==='short'?'短':'长',cls=b.kind==='short'?'short':'long';return '<div class="landing-card" data-book="'+b.name+'"><div class="lc-icon '+cls+'">'+icon+'</div><div class="lc-info"><div class="lc-name">'+b.name+'</div><div class="lc-meta">'+(b.kind==='short'?'短篇集':'长篇')+' · '+b.genre+'</div></div><div class="lc-badge">书</div></div>';}).join('');
  return '<div class="landing"><div class="landing-logo">墨</div><div class="landing-title">CLWriting Studio</div><div class="landing-sub">沉浸式写作空间</div><div class="landing-recent"><div class="landing-recent-title">最近打开的书库</div>'+libCards+'<div class="landing-recent-title" style="margin-top:18px">最近打开的书</div>'+bookCards+'</div><div class="landing-actions"><span class="btn primary" id="landManage">📚 书库管理</span><span class="btn" id="landNew">+ 新建书库</span><span class="btn" id="landOpen">📂 打开已有书库</span></div></div>';
}
function bindLanding(){
  el('workspace').querySelectorAll('.landing-card[data-lid]').forEach(function(c){c.onclick=function(){var lid=c.dataset.lid;var lib=LIBRARIES.find(function(l){return l.id===lid;});if(!lib)return;state.currentLibId=lid;state.view='shelf';render();showHint('已打开书库「'+lib.name+'」');};});
  el('workspace').querySelectorAll('.landing-card[data-book]').forEach(function(c){c.onclick=function(){openBookByName(c.dataset.book);};});
  var m=el('landManage'),n=el('landNew'),o=el('landOpen');
  if(m)m.onclick=function(){state.view='libraries';render();};
  if(n)n.onclick=function(){openNewVault();};
  if(o)o.onclick=function(){showHint('选择已有书库目录（mockup 演示 · 实际由桌面端 OS 文件对话框完成）');};
}

// ===== 书库管理页 =====
function renderLibraries(){
  var cards=LIBRARIES.map(function(l){var libBooks=SHELF_BOOKS.filter(function(b){return b.libId===l.id;});var bookCount=libBooks.length;var totalW=libBooks.reduce(function(s,b){return s+b.words;},0);var icon=l.id==='lib_guanwei'?'书':'书',cls='long';return '<div class="lib-card"><div class="lib-icon '+cls+'">'+icon+'</div><div class="lib-info"><div class="lib-name">'+l.name+'</div><div class="lib-path">'+l.path+'</div><div class="lib-stats"><span class="lib-stat"><b>'+bookCount+'</b> 本书</span><span class="lib-stat"><b>'+(totalW>=10000?(totalW/10000).toFixed(1)+'万':totalW)+'</b> 字</span></div></div><div class="lib-actions"><span class="btn" data-lid="'+l.id+'" data-act="open">打开书架</span><span class="btn" data-lid="'+l.id+'" data-act="addbook">+ 新建书</span><span class="btn" data-lid="'+l.id+'" data-act="rename">重命名</span><span class="btn danger" data-lid="'+l.id+'" data-act="del">删除</span></div></div>';}).join('');
  return '<div class="lib-page"><div class="lib-head"><div class="lib-title">书库</div><div class="lib-sub">'+LIBRARIES.length+' 个书库 · '+currentLibLabel()+'</div></div>'+cards+'<div style="margin-top:18px"><span class="btn primary" id="libNewVault">+ 新建书库</span></div></div>';
}
function bindLibraries(){
  el('workspace').querySelectorAll('[data-act]').forEach(function(b){b.onclick=function(){var lid=b.dataset.lid,act=b.dataset.act;var lib=LIBRARIES.find(function(l){return l.id===lid;});if(!lib)return;if(act==='open'){state.currentLibId=lid;state.view='shelf';render();showHint('已打开书库「'+lib.name+'」');}else if(act==='addbook'){state.view='newbook';state.nbPhase='form';state.nbKind='long';state.nbLibId=lib.id;render();showHint('在「'+lib.name+'」中新建书籍');}else if(act==='rename'){var nn=prompt('书库名称：',lib.name);if(nn&&nn.trim()){lib.name=nn.trim();renderLibraries();bindLibraries();showHint('已重命名');}}else if(act==='del'){if(confirm('确定删除书库「'+lib.name+'」？书库内的书籍将一并移除。')){SHELF_BOOKS=SHELF_BOOKS.filter(function(b){return b.libId!==lid;});var i=LIBRARIES.findIndex(function(l){return l.id===lid;});if(i>=0)LIBRARIES.splice(i,1);renderLibraries();bindLibraries();showHint('已删除');}}};});
  var nv=el('libNewVault');if(nv)nv.onclick=openNewVault;
}

// ===== 新建书库弹层 =====
function openNewVault(){el('vaultMask').classList.add('show');el('vaultModalTitle').textContent='新建书库';el('vfName').value='';updateVaultPath();bindVaultForm();}
function closeNewVault(){el('vaultMask').classList.remove('show');}
function updateVaultPath(){var name=(el('vfName').value||'新书库').trim();el('vfPath').value='~/CLWriting/'+name;el('vfPathPreviewText').textContent='~/CLWriting/'+name+'/├── 定稿/├── 大纲/├── 设定/├── 文风/└── 工作区/';}
function bindVaultForm(){
  el('vfName').oninput=updateVaultPath;
  el('vaultSubmit').onclick=function(){var name=el('vfName').value.trim();if(!name){showHint('请填写书库名称');return;}var id='lib_'+Date.now();LIBRARIES.push({id:id,name:name,path:'~/CLWriting/'+name,dot:'gray',lastOpen:'刚刚'});closeNewVault();showHint('书库「'+name+'」已创建');state.view='libraries';render();};
  el('vaultCancel').onclick=closeNewVault;
  el('vaultClose').onclick=closeNewVault;
  el('vaultMask').onclick=function(e){if(e.target===el('vaultMask'))closeNewVault();};
}
var shelfB=el('shelfBtn');if(shelfB)shelfB.onclick=function(){state.view='shelf';render();};

// ===== 角色关系图 =====
let relSel=null;
function relNodeColor(dot){
  return dot==='green'?'var(--ink-cyan)':dot==='cyan'?'var(--ink-cyan)':dot==='yellow'?'var(--ochre)':dot==='red'?'var(--cinnabar)':'var(--text-3)';
}
function relEdgeColor(type){
  return type==='tension'?'var(--cinnabar)':type==='active'?'var(--ink-cyan)':type==='past'?'var(--ochre)':'var(--text-3)';
}
function renderRelations(){
  const c=el('content'),ns=RELATIONS.nodes.map(n=>({...n})),es=RELATIONS.edges;
  const W=760,H=460;
  // 简易力导向：初始数据已有 x/y，做几步松弛
  function step(){
    const k=0.08;
    for(let i=0;i<ns.length;i++){for(let j=i+1;j<ns.length;j++){
      const dx=ns[j].x-ns[i].x,dy=ns[j].y-ns[i].y;
      const d2=dx*dx+dy*dy+0.001;const f=k/d2;
      const d=Math.sqrt(d2);const fx=dx/d*f,fy=dy/d*f;
      ns[i].x-=fx;ns[i].y-=fy;ns[j].x+=fx;ns[j].y+=fy;
    }}
    for(const e of es){
      const a=ns.find(n=>n.id===e.from),b=ns.find(n=>n.id===e.to);
      if(!a||!b)continue;
      const f=k*(a.x-b.x),g=k*(a.y-b.y);
      a.x+=f;a.y+=g;b.x-=f;b.y-=g;
    }
    for(const n of ns){n.x=Math.max(0.06,Math.min(0.94,n.x));n.y=Math.max(0.06,Math.min(0.94,n.y));}
  }
  for(let i=0;i<60;i++)step();
  const toS=(v)=>`${Math.round(v*W)}`;const toSy=(v)=>`${Math.round(v*H)}`;
  const edgeSvg=es.map(e=>{
    const a=ns.find(n=>n.id===e.from),b=ns.find(n=>n.id===e.to);if(!a||!b)return'';
    const x1=parseInt(toS(a.x)),y1=parseInt(toSy(a.y)),x2=parseInt(toS(b.x)),y2=parseInt(toSy(b.y));
    const mx=(x1+x2)/2,my=(y1+y2)/2-16;
    const col=relEdgeColor(e.type);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="stroke:${col}" stroke-width="${e.active?2.5:1.5}" stroke-opacity="${e.active?.45:.22}" stroke-dasharray="${e.type==='past'?'5 3':'none'}"/>`
      +`<text x="${mx}" y="${my}" text-anchor="middle" font-size="10" style="fill:${col}" fill-opacity=".7" font-family="system-ui,sans-serif">${e.label}</text>`;
  }).join('');
  const nodeSvg=ns.map(n=>{
    const cx=toS(n.x),cy=toSy(n.y),col=relNodeColor(n.dot),r=n.id===relSel?22:18;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" style="cursor:pointer;fill:${col};stroke:${col}" fill-opacity=".18" stroke-width="2.5" class="rel-node" data-id="${n.id}"/>`
      +`<circle cx="${cx}" cy="${cy}" r="${r-8}" style="fill:${col}" fill-opacity=".9"/>`
      +`<text x="${cx}" y="${cy+1}" text-anchor="middle" dominant-baseline="middle" font-size="9.5" fill="#fff" font-weight="600" font-family="system-ui,sans-serif">${n.name}</text>`
      +`<text x="${cx}" y="${+cy+r+14}" text-anchor="middle" font-size="10" style="fill:var(--text-2)" font-family="system-ui,sans-serif">${n.role}</text>`;
  }).join('');
  c.innerHTML=`<div class="content-scroll"><div class="bento-wrap"><div class="bento-head"><h1 class="bento-title">角色关系</h1><div class="bento-sub">观微 · ${ns.length} 人 · ${es.length} 条关联 · 节点可点选</div></div>`
    +`<div class="rel-graph"><svg viewBox="0 0 ${W} ${H}" class="rel-svg" preserveAspectRatio="xMidYMid meet">${edgeSvg}${nodeSvg}</svg></div>`
    +`<div class="rel-legend" style="display:flex;gap:16px;margin-top:16px;flex-wrap:wrap;justify-content:center">`
      +`<span style="font-size:11px;color:var(--text-2)"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--ink-cyan);margin-right:4px"></span>活跃线</span>`
      +`<span style="font-size:11px;color:var(--text-2)"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--cinnabar);margin-right:4px"></span>张力线</span>`
      +`<span style="font-size:11px;color:var(--text-2)"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--ochre);margin-right:4px"></span>历史线</span>`
      +`<span style="font-size:11px;color:var(--text-2)"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--text-3);margin-right:4px"></span>普通</span>`
    +`</div></div></div>`;
  c.querySelectorAll('.rel-node').forEach(n=>n.onclick=()=>{relSel=relSel===n.dataset.id?null:n.dataset.id;renderRelations();renderRelRight();});
}
function renderRelRight(){
  const r=el('rightctx');
  if(!relSel){r.innerHTML='<div class="card"><div class="card-title">节点</div><div style="font-size:12px;color:var(--text-2);line-height:1.7">点击图中角色查看详情与关联</div></div>';return;}
  const n=RELATIONS.nodes.find(x=>x.id===relSel);if(!n)return;
  const links=RELATIONS.edges.filter(e=>e.from===relSel||e.to===relSel);
  const col=relNodeColor(n.dot);
  const cards=links.map(e=>{
    const otherId=e.from===relSel?e.to:e.from;
    const other=RELATIONS.nodes.find(x=>x.id===otherId);
    if(!other)return'';
    const oc=relNodeColor(other.dot);
    return `<div class="kv click" data-rid="${other.id}"><span class="k"><span class="dot" style="display:inline-block;margin-right:6px;background:${oc}"></span>${other.name}</span><span class="v" style="color:${relEdgeColor(e.type)}">${e.label}</span></div>`;
  }).join('');
  r.innerHTML=`<div class="card"><div class="card-title">角色 <span style="color:${col}">● ${n.name}</span></div><div class="kv"><span class="k">身份</span><span class="v">${n.role}</span></div><div class="kv"><span class="k">状态</span><span class="v cyan">${n.info}</span></div></div>`
    +`<div class="card"><div class="card-title">关联 · ${links.length}</div>${cards||'<div style="font-size:12px;color:var(--text-2)">无关联</div>'}</div>`;
  r.querySelectorAll('.kv.click[data-rid]').forEach(x=>x.onclick=()=>{relSel=x.dataset.rid;renderRelations();renderRelRight();});
}

// ===== 初始化 =====
