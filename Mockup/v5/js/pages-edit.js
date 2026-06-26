function renderTree(){
  const F=state.book==='short'?S_FILES:FILES;
  const folderTag=id=>id.endsWith('body')?(state.book==='short'?'pieces':'chapters'):id.endsWith('ol')?'outline':id.endsWith('set')?'设定':'草稿';
  const label=state.book==='short'?'篇':'章';
  let h=`<div class="tree-head"><span class="tree-head-icon">📄</span><span class="tree-head-label">${label}列表</span></div>`;
  F.filter(f=>f.folder).forEach(fd=>{
    h+=`<div class="folder"><span class="caret">${fd.open?'▾':'▸'}</span>${fd.name}<span class="tag">${folderTag(fd.id)}</span></div>`;
    if(fd.open){
      F.filter(c=>c.parent===fd.id).forEach(c=>{h+=`<div class="file indent ${state.file===c.id?'active':''}" data-id="${c.id}" data-piece="${c.no||''}">${c.dot?`<span class="dot ${c.dot}"></span>`:''}${c.name}</div>`;});
    }
  });
  el('tree').innerHTML=h;
  el('tree').querySelectorAll('.file').forEach(f=>f.onclick=()=>{state.file=f.dataset.id;if(f.dataset.piece)state.piece=Number(f.dataset.piece);state.ledgerDetail=null;state.loading=true;renderTree();renderFileMid();renderEditRight();});
  el('tree').querySelectorAll('.folder').forEach((fd,i)=>fd.onclick=()=>{const f=F.filter(x=>x.folder)[i];if(f){f.open=!f.open;renderTree();}});
}
function renderFileMid(){
  const F=state.book==='short'?S_FILES:FILES;
  const f=F.find(x=>x.id===state.file)||(state.book==='short'?S_FILES.find(x=>x.type==='piece'):CHAPTERS[0]);
  const c=el('content');
  if(state.loading){
    c.innerHTML=`<div class="content-scroll"><div class="editor-inner"><div class="sk-toolbar"><div class="sk-line"></div><div class="sk-spacer"></div><div class="sk-btn"></div></div><div class="sk-fm"><div class="sk-line"></div><div class="sk-line"></div><div class="sk-line"></div></div><div class="sk-title"></div><div class="sk-line"></div><div class="sk-line"></div><div class="sk-line"></div><div class="sk-line" style="width:82%"></div><div class="sk-line"></div><div class="sk-line" style="width:64%"></div></div></div>`;
    clearTimeout(renderFileMid._t);
    renderFileMid._t=setTimeout(()=>{state.loading=false;renderFileMid();},380);
    return;
  }
  if(f.type==='piece'){
    const p=S_PIECES.find(x=>x.no===f.no)||S_PIECES[0];
    const target=S_META.target,pct0=Math.min(Math.round(p.words/target*100),999);
    const pr=p.prose.map(s=>`<p>${s}</p>`).join('');
    const emoStr=p.emo.map(e=>e[1]).join(' → ');
    c.innerHTML=`<div class="content-scroll"><div class="editor-inner"><div class="edit-toolbar"><span class="et-file">${p.title}</span><span class="et-dirty saved" id="etDirty">✓ 已保存</span><span class="et-wc"><b id="etWc">${p.words.toLocaleString()}</b> / ${target} 字<span class="et-bar"><div id="etBar" style="width:${Math.min(pct0,100)}%"></div></span><span id="etPct">${pct0}%</span></span><span class="et-spacer"></span><span class="et-meta">第 12 行 第 5 列</span><span class="et-meta">UTF-8</span><span class="et-meta">短篇 · 正文</span><select id="etEmo" title="目标情绪">${['孤独→释然','疲惫→战栗','好奇→惊惧','平静→震撼','欢愉→怅惘'].map(e=>`<option ${e===p.targetEmo?'selected':''}>${e}</option>`).join('')}</select><span class="btn" id="etRevert">⏪ 回滚</span><span class="btn primary" id="etSave">💾 保存</span></div><div class="fm-bar"><span class="fm cyan">类型 · <b>短篇</b></span><span class="fm">第 ${p.no} 篇 · <b>${p.title}</b></span><span class="fm ochre">情绪 · <b>${p.targetEmo}</b></span><span class="fm">字数 · <b>${p.words.toLocaleString()} / ${target}</b></span><span class="fm cyan">实际情绪 · <b>${emoStr}</b></span></div><h1 class="chapter-title">${p.title}</h1><div class="chapter-meta-line">${S_META.genre} · 第 ${p.no} 篇 · 核心反转：<b style="color:var(--cinnabar)">${p.reversal}</b> · <b style="color:var(--ink-cyan)">正文模式 · 可编辑</b></div><div class="prose" id="prose" contenteditable="true" spellcheck="false">${pr}</div></div></div>`;
    bindEditor(p,target);
  }else if(!f.type||f.type==='chapter'){
    const ch=CHAPTERS.find(x=>x.id===state.file)||CHAPTERS[0];
    if(ch.words===0){
      const fm0=ch.fm.map(x=>`<span class="fm ${x[2]||''}">${x[0]} · <b>${x[1]}</b></span>`).join('');
      c.innerHTML=`<div class="content-scroll"><div class="editor-inner"><div class="fm-bar">${fm0}</div><h1 class="chapter-title">${ch.name}</h1><div class="chapter-meta-line">长篇玄幻 · 场景「${ch.scene}」 · ${ch.pov}视角 · <b style="color:var(--ochre)">待开写</b></div><div class="state-empty"><div class="se-icon">✍️</div><div class="se-text">本章尚未开写</div><div class="se-sub">细纲已就绪 · 去工作台让 AI 生成首版，或直接在此续写</div><span class="btn primary" id="goWb">去工作台生成 →</span></div></div></div>`;
      const gw=el('goWb');if(gw)gw.onclick=()=>{state.mode='workbench';state.wbChapter=Number((state.file||'ch3').replace('ch',''))||3;render();};
      return;
    }
    const fm=ch.fm.map(x=>`<span class="fm ${x[2]||''}">${x[0]} · <b>${x[1]}</b></span>`).join('');
    const pr=ch.prose.map(p=>{const t=p.trim();return /^「.+」。?$/.test(t)?`<p class="quote">${t}</p>`:`<p>${p}</p>`}).join('');
    const target=2500,pct0=Math.min(Math.round(ch.words/target*100),999);
    const sc=['起','承','探索','转','悬念','合'],pv=['林远','赵衡','上帝视角'];
    c.innerHTML=`<div class="content-scroll"><div class="editor-inner"><div class="edit-toolbar"><span class="et-file">${ch.name.split(' · ')[1]||ch.name}</span><span class="et-dirty saved" id="etDirty">✓ 已保存</span><span class="et-wc"><b id="etWc">${ch.words.toLocaleString()}</b> / ${target} 字<span class="et-bar"><div id="etBar" style="width:${Math.min(pct0,100)}%"></div></span><span id="etPct">${pct0}%</span></span><span class="et-spacer"></span><span class="et-meta">第 12 行 第 5 列</span><span class="et-meta">UTF-8</span><span class="et-meta">长篇 · 正文</span><select id="etScene" title="场景">${sc.map(s=>`<option ${s===ch.scene?'selected':''}>${s}</option>`).join('')}</select><select id="etPov" title="视角">${pv.map(p=>`<option ${p===ch.pov?'selected':''}>${p}</option>`).join('')}</select><span class="btn" id="etRevert">⏪ 回滚</span><span class="btn primary" id="etSave">💾 保存</span></div><div class="fm-bar">${fm}</div><h1 class="chapter-title">${ch.name}</h1><div class="chapter-meta-line">长篇玄幻 · ${ch.fm[5]?ch.fm[5][1]:'草稿'} · 场景「${ch.scene}」 · ${ch.pov}视角 · <b style="color:var(--ink-cyan)">正文模式 · 可编辑</b></div><div class="prose" id="prose" contenteditable="true" spellcheck="false">${pr}</div></div></div>`;
    bindEditor(ch,target);
  }else if(f.type==='setting'){
    const s=SETTINGS_DOCS.find(x=>x.id===f.id)||{name:f.name,fields:[]};
    const fields=s.fields.map(([k,v])=>`<div class="sfield"><label>${k}</label>${v.length>14?`<textarea>${v}</textarea>`:`<input value="${v}">`}</div>`).join('');
    c.innerHTML=`<div class="content-scroll"><div class="editor-inner"><div class="fm-bar"><span class="fm cyan">类型 · <b>设定</b></span><span class="fm">分类 · <b>${s.cat}</b></span><span class="fm">字数 · <b>${s.fields.length} 项</b></span></div><h1 class="chapter-title">${s.name}</h1><div class="chapter-meta-line">设定文档 · <b style="color:var(--ink-cyan)">设定模式</b> · 可编辑</div>${fields}<div class="btn-row"><span class="btn primary">保存设定</span><span class="btn">+ 新增字段</span></div></div></div>`;
  }else if(f.type==='outline'){
    const acts=OUTLINE.map((a,i)=>`<div class="ol-act"><h3>${a.h}</h3><div class="ol-sub">${a.sub}</div>${a.items.map((it,j)=>`<div class="ol-item"><span class="n">${i+1}.${j+1}</span><span contenteditable="true">${it}</span></div>`).join('')}</div>`).join('');
    c.innerHTML=`<div class="content-scroll"><div class="editor-inner"><div class="fm-bar"><span class="fm cyan">类型 · <b>大纲</b></span><span class="fm">结构 · <b>三幕</b></span><span class="fm">预计 · <b>30 章</b></span></div><h1 class="chapter-title">总纲</h1><div class="chapter-meta-line">大纲文档 · <b style="color:var(--ink-cyan)">大纲模式</b> · 可编辑</div>${acts}<div class="btn-row"><span class="btn primary">保存大纲</span><span class="btn">+ 新增条目</span></div></div></div>`;
  }
}
function bindEditor(ch,target){
  const prose=el('prose');if(!prose)return;
  const dirty=el('etDirty'),wc=el('etWc'),bar=el('etBar'),pct=el('etPct');
  const cnt=()=>(prose.textContent||'').replace(/\s/g,'').length;
  function upd(){const n=cnt();wc.textContent=n.toLocaleString();const p=Math.min(Math.round(n/target*100),999);bar.style.width=Math.min(p,100)+'%';pct.textContent=p+'%';bar.style.background=n<target*0.7?'var(--cinnabar)':n>target*1.3?'var(--ochre)':'var(--ink-cyan)';}
  prose.addEventListener('input',()=>{dirty.textContent='● 未保存';dirty.classList.remove('saved');upd();});
  el('etSave').onclick=()=>{ch.prose=Array.from(prose.querySelectorAll('p')).map(p=>p.textContent);ch.words=cnt();dirty.textContent='✓ 已保存';dirty.classList.add('saved');upd();showHint('已保存（mockup 演示）');};
  el('etRevert').onclick=openRevert;
  const sceneEl=el('etScene'),povEl=el('etPov'),emoEl=el('etEmo');
  if(sceneEl)sceneEl.onchange=()=>{ch.scene=sceneEl.value;showHint('场景 → '+ch.scene);};
  if(povEl)povEl.onchange=()=>{ch.pov=povEl.value;showHint('视角 → '+ch.pov);};
  if(emoEl)emoEl.onchange=()=>{ch.targetEmo=emoEl.value;showHint('目标情绪 → '+ch.targetEmo);};
}
function renderEditRight(){
  const F=state.book==='short'?S_FILES:FILES;
  const f=F.find(x=>x.id===state.file)||{};
  if(f.type==='piece'){
    const p=S_PIECES.find(x=>x.no===f.no)||S_PIECES[0];
    const pct=Math.round(p.words/S_META.target*100);
    const dc=p.dot==='red'?'var(--cinnabar)':p.dot==='yellow'?'var(--ochre)':'var(--ink-cyan)';
    const items=S_LEDGER.slice(0,3);
    const recv=p.payoffs.filter(e=>!e.unresolved).length;
    el('rightctx').innerHTML=`<div class="card"><div class="card-title">本篇 <span style="color:${dc}">● ${p.words>=S_META.target?'达标':'草稿'}</span></div><div class="kv"><span class="k">字数</span><span class="v">${p.words.toLocaleString()}</span></div><div class="progress"><div style="width:${Math.min(pct,100)}%"></div></div><div class="kv"><span class="k">目标</span><span class="v">${S_META.target} · ${pct}%</span></div><div class="kv"><span class="k">目标情绪</span><span class="v cyan">${p.targetEmo}</span></div><div class="kv"><span class="k">核心反转</span><span class="v" style="font-size:11px;text-align:right;max-width:140px;line-height:1.5">${p.reversal.slice(0,20)}…</span></div><div class="kv"><span class="k">伏笔回收</span><span class="v">${recv}/${p.payoffs.length}</span></div></div><div class="card"><div class="card-title">情绪曲线</div><div style="font-size:12px;color:var(--text-2);margin-bottom:8px">${p.emo.map(e=>e[0]).join(' → ')}</div><div style="display:flex;align-items:flex-end;gap:6px;height:50px">${p.emo.map(e=>{const h=Math.round(e[2]/10*100);const col=e[2]>=8?'var(--cinnabar)':'var(--ink-cyan)';return `<div style="flex:1;height:${h}%;background:${col};border-radius:3px 3px 0 0;min-height:4px" title="${e[0]} · ${e[1]}（${e[2]}/10）"></div>`;}).join('')}</div><div style="display:flex;justify-content:space-between;margin-top:4px;font-size:10px;color:var(--text-3)">${p.emo.map(e=>e[0].slice(0,2)).join(' ')}</div></div><div class="card"><div class="card-title">反转线索</div><div style="font-size:12px;color:var(--ink);line-height:1.7">${p.reversal}</div><div class="btn-row" style="margin-top:8px"><span class="btn primary" id="gotoPiece" style="font-size:11px;padding:4px 10px">看篇详情 →</span></div></div><div class="card"><div class="card-title">伏笔提醒 <span style="color:var(--text-3)">${items.length}</span></div>${items.map(l=>`<div class="ledger-item click" data-lid="${l.id}"><span class="dot ${l.dot}"></span><div><b>${l.type}·${l.name}</b><div class="desc">${l.ch} · ${l.st}</div></div></div>`).join('')}</div>`;
    el('rightctx').querySelectorAll('.ledger-item.click').forEach(x=>x.onclick=()=>{state.mode='overview';state.ov='a_ledger';state.ledgerDetail=x.dataset.lid;render();});
    const gp=el('gotoPiece');if(gp)gp.onclick=()=>{state.mode='overview';state.ov='a_piece';state.piece=p.no;render();};
  }else if(!f.type||f.type==='chapter'){
    const ch=CHAPTERS.find(x=>x.id===state.file)||CHAPTERS[0];
    const pct=Math.round(ch.words/2500*100);
    const dc=ch.dot==='red'?'var(--cinnabar)':ch.dot==='yellow'?'var(--ochre)':'var(--ink-cyan)';
    const rel=LEDGER.filter(l=>l.ch.includes(ch.name.split(' · ')[0])||l.echo.includes(ch.name.split(' · ')[0]));
    const items=(rel.length?rel:LEDGER).slice(0,3);
    el('rightctx').innerHTML=`<div class="card"><div class="card-title">本章 <span style="color:${dc}">● ${ch.fm[5]?ch.fm[5][1]:'草稿'}</span></div><div class="kv"><span class="k">字数</span><span class="v">${ch.words.toLocaleString()}</span></div><div class="progress"><div style="width:${Math.min(pct,100)}%"></div></div><div class="kv"><span class="k">目标</span><span class="v">2,500 · ${pct}%</span></div><div class="kv"><span class="k">场景</span><span class="v cyan">${ch.scene}</span></div><div class="kv"><span class="k">视角</span><span class="v">${ch.pov}</span></div><div class="kv"><span class="k">钩子</span><span class="v">${ch.hook}</span></div><div class="kv"><span class="k">情绪</span><span class="v">${ch.fm[4]?ch.fm[4][1]:'—'}</span></div></div>
    <div class="card"><div class="card-title">账本提醒 <span style="color:var(--text-3)">${items.length}</span> <span style="color:var(--ink-cyan);cursor:pointer;text-transform:none;font-weight:500" id="gotoLedger">看全部 →</span></div>${items.map(l=>`<div class="ledger-item click" data-lid="${l.id}"><span class="dot ${l.dot}"></span><div><b>${l.type}·${l.name}</b><div class="desc">${l.ch} · ${l.st}</div></div></div>`).join('')}</div>
    <div class="card"><div class="card-title">出场角色</div><div class="kv"><span class="k">林远</span><span class="v cyan">主视角</span></div>${(ch.id>='ch4')?`<div class="kv"><span class="k">赵衡</span><span class="v">在场</span></div>`:''}${(ch.id>='ch7')?`<div class="kv"><span class="k">赵衡</span><span class="v ochre">双视角</span></div>`:''}</div>`;
    el('rightctx').querySelectorAll('.ledger-item.click').forEach(x=>x.onclick=()=>{state.mode='overview';state.ov='a_ledger';state.ledgerDetail=x.dataset.lid;render();});
    const gl=el('gotoLedger');if(gl)gl.onclick=()=>{state.mode='overview';state.ov='a_ledger';state.ledgerDetail=null;render();};
  }else if(f.type==='setting'){
    const s=SETTINGS_DOCS.find(x=>x.id===state.file)||{};
    el('rightctx').innerHTML=`<div class="card"><div class="card-title">关联</div><div class="kv"><span class="k">出场章节</span><span class="v cyan">${s.id==='sr_zhaoheng'?'3':'5'}</span></div><div class="kv"><span class="k">账本引用</span><span class="v">${s.id==='sr_linyuan'?'4':'2'}</span></div></div><div class="card"><div class="card-title">人物关系</div><div class="kv"><span class="k">林远</span><span class="v cyan">${s.id==='sr_linyuan'?'本人':'主角'}</span></div><div class="kv"><span class="k">赵衡</span><span class="v">${s.id==='sr_zhaoheng'?'本人':'师兄'}</span></div></div><div class="card"><div class="card-title">提示</div><div style="font-size:12px;color:var(--text-2);line-height:1.7">设定保存后，相关章节的元数据会提示更新。</div></div>`;
  }else{
    el('rightctx').innerHTML=`<div class="card"><div class="card-title">大纲统计</div><div class="kv"><span class="k">结构</span><span class="v">三幕</span></div><div class="kv"><span class="k">预计章节</span><span class="v cyan">30</span></div><div class="kv"><span class="k">已写</span><span class="v">5 / 30</span></div><div class="progress"><div style="width:17%"></div></div></div><div class="card"><div class="card-title">提示</div><div style="font-size:12px;color:var(--text-2);line-height:1.7">大纲条目可直接点选编辑。完成后可生成章节占位。</div></div>`;
  }
}

// ===== 总览态 =====
function renderOvNav(){
  const groups=state.book==='short'?[OV_NAV[0],{group:'分析',items:[{id:'a_piece',name:'篇详情',ico:'❡'},...OV_NAV[1].items]}]:OV_NAV;
  let h='';
  groups.forEach(g=>{
    h+=`<div class="tree-section"><div class="nav-group">${g.group}</div>`;
    g.items.forEach(it=>h+=`<div class="file ${state.ov===it.id?'active':''}" data-id="${it.id}"><span style="width:16px;text-align:center;color:var(--text-3)">${it.ico}</span>${it.name}</div>`);
    h+=`</div>`;
  });
  el('ovnav').innerHTML=h;
  el('ovnav').querySelectorAll('.file').forEach(f=>f.onclick=()=>{state.ov=f.dataset.id;state.ledgerDetail=null;renderOvNav();renderOvMid();renderOvRight();renderStatus();});
}
function emoSVG(emo){
  const W=380,H=150,padL=26,padR=14,padT=18,padB=36,iw=W-padL-padR,ih=H-padT-padB,n=emo.length,mx=Math.max(...emo.map(e=>e[2]));
  const pts=emo.map((e,i)=>({x:padL+(n===1?iw/2:i*iw/(n-1)),y:padT+(10-e[2])/10*ih,e}));
  const line=pts.map(p=>p.x+','+p.y).join(' ');
  const yl=[0,5,10].map(v=>{const y=padT+(10-v)/10*ih;return `<line x1="${padL}" y1="${y}" x2="${padL+iw}" y2="${y}" stroke="var(--border)" stroke-dasharray="2 3"/><text x="${padL-6}" y="${y+3}" text-anchor="end" font-size="9" fill="var(--text-3)">${v}</text>`}).join('');
  const dl=pts.map(p=>{const pk=p.e[2]===mx,col=pk?'var(--cinnabar)':'var(--ink-cyan)';return `<circle cx="${p.x}" cy="${p.y}" r="${pk?6:4}" fill="${col}"><title>${p.e[0]} · ${p.e[1]}（强度 ${p.e[2]}/10）</title></circle><text x="${p.x}" y="${p.y-10}" text-anchor="middle" font-size="10" fill="${col}" font-weight="${pk?600:400}">${p.e[1]}·${p.e[2]}</text><text x="${p.x}" y="${H-12}" text-anchor="middle" font-size="10" fill="var(--text-2)">${p.e[0]}</text>`}).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="emo-svg" preserveAspectRatio="xMidYMid meet"><polygon points="${padL},${padT+ih} ${line} ${padL+iw},${padT+ih}" fill="var(--ink-cyan)" opacity="0.08"/>${yl}<polyline points="${line}" fill="none" stroke="var(--ink-cyan)" stroke-width="2" stroke-linejoin="round"/>${dl}</svg>`;
}
function renderPieceDetail(){
  const p=S_PIECES.find(x=>x.no===state.piece)||S_PIECES[0],c=el('content');
  const prev=S_PIECES.find(x=>x.no===p.no-1),next=S_PIECES.find(x=>x.no===p.no+1);
  const recv=p.payoffs.filter(e=>!e.unresolved).length;
  const peak=Math.max(...p.emo.map(e=>e[2]));
  c.innerHTML=`<div class="content-scroll"><div class="bento-wrap"><div class="bento-head"><h1 class="bento-title">${p.title}</h1><div class="bento-sub">${S_META.genre} · 目标情绪 ${p.targetEmo} · ${p.words.toLocaleString()} 字</div></div>
    <div class="pd-pager"><span class="btn${prev?'':' disabled'}" id="pdPrev">← 上一篇</span><span class="pd-no">第 ${p.no} 篇 / 共 ${S_PIECES.length} 篇</span><span class="btn${next?'':' disabled'}" id="pdNext">下一篇 →</span></div>
    <div class="pd-reversal"><span class="reversal-label">核心反转</span>${p.reversal}</div>
    <div class="bento-grid">
      <div class="bento-card bento-lg"><div class="bc-menu">⋮</div><div class="bc-label">情绪曲线 · 强度 1-10 · 峰值朱砂高亮</div>${emoSVG(p.emo)}</div>
      <div class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">伏笔回收</div><div class="bc-stat">${recv}<span>/${p.payoffs.length}</span></div></div>
      <div class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">情绪峰值</div><div class="bc-stat" style="color:var(--cinnabar)">${peak}</div></div>
      <div class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">反转铺垫</div><div class="bc-stat">${p.setups.length}<span> 处</span></div></div>
      <div class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">本篇字数</div><div class="bc-stat">${p.words.toLocaleString()}</div></div>
      <div class="bento-card bento-full bento-r2 scroll"><div class="bc-menu">⋮</div><div class="bc-label">反转线索表</div><div class="pd-core"><span class="reversal-label">核心反转</span>${p.reversal}</div><ul class="pd-setups">${p.setups.map(s=>`<li><span class="setup-pos">[${s.pos}]</span>${s.txt}</li>`).join('')}</ul></div>
      <div class="bento-card bento-full bento-r2 scroll"><div class="bc-menu">⋮</div><div class="bc-label">伏笔回收明细 ${recv}/${p.payoffs.length}</div><ul class="pd-payoffs">${p.payoffs.map(e=>`<li class="${e.unresolved?'unresolved':''}"><span class="payoff-name">${e.name}</span>${e.unresolved?'<span class="tag red">未回收</span>':`<span class="payoff-at">→ ${e.at}</span>`}</li>`).join('')}</ul></div>
    </div></div></div>`;
  if(prev)el('pdPrev').onclick=()=>{state.piece=prev.no;renderPieceDetail();renderOvRight();renderStatus();};
  if(next)el('pdNext').onclick=()=>{state.piece=next.no;renderPieceDetail();renderOvRight();renderStatus();};
}
function renderOvMid(){
  const id=state.ov,c=el('content');
  if(state.ov==='a_piece')return renderPieceDetail();
  if(state.ov==='a_ledger'&&state.ledgerDetail)return renderLedgerTrace(state.ledgerDetail);
  if(state.ov==='a_relations')return renderRelations();
  const hd=(t,s)=>'<div class="bento-head"><h1 class="bento-title">'+t+'</h1><div class="bento-sub">'+s+'</div></div>';
  const mu='<div class="bc-menu">⋮</div>';
  if(state.book==='short'){
    if(id==='o1'){
      const total=S_PIECES.reduce((s,p)=>s+p.words,0),pct=Math.round(total/(S_META.target*S_PIECES.length)*100);
      c.innerHTML=`<div class="content-scroll"><div class="bento-wrap">${hd(S_META.name+' · 作品概要',S_META.genre+' · 短篇集 · 共 '+S_PIECES.length+' 篇 · 无卷结构')}<div class="bento-grid">
        <div class="bento-card bento-lg">${mu}<div class="bc-label">集子完成度</div><div class="bc-ring" style="background:conic-gradient(var(--ink-cyan) 0 ${pct}%,color-mix(in srgb,var(--border) 55%,transparent) ${pct}% 100%)"><span>${pct}%</span></div><div class="bc-foot">${total.toLocaleString()} 字 · ${S_PIECES.length} 篇 · 每篇独立情绪曲线 / 反转设计</div><div class="bc-progress"><div style="width:${pct}%"></div></div></div>
        <div class="bento-card">${mu}<div class="bc-label">总字数</div><div class="bc-stat">${total.toLocaleString()}</div></div>
        <div class="bento-card">${mu}<div class="bc-label">篇数</div><div class="bc-stat">${S_PIECES.length}</div></div>
        <div class="bento-card">${mu}<div class="bc-label">完成度</div><div class="bc-stat">${pct}<span>%</span></div></div>
        <div class="bento-card">${mu}<div class="bc-label">未回收伏笔</div><div class="bc-stat" style="color:var(--cinnabar)">${S_LEDGER.filter(l=>l.dot==='red').length}</div></div>
        <div class="bento-card bento-action"><div class="bc-label">篇列表</div><div class="bc-list">${S_PIECES.map(p=>`<div class="bc-list-row" data-no="${p.no}"><span class="dot ${p.dot}"></span><span>第${p.no}篇 · ${p.title}</span><span class="lr-sub">${p.words}字 · ${p.targetEmo}</span></div>`).join('')}</div></div>
      </div></div></div>`;
      c.querySelectorAll('[data-no]').forEach(x=>x.onclick=()=>{state.piece=Number(x.dataset.no);state.ov='a_piece';renderOvNav();renderOvMid();renderOvRight();renderStatus();});
      return;
    }
    if(id==='o2'){
      const mx=Math.max(...S_PIECES.map(x=>x.words));
      const sum=S_PIECES.reduce((s,x)=>s+x.words,0),avg=Math.round(sum/S_PIECES.length),bad=S_PIECES.filter(x=>x.dot==='red'||x.dot==='yellow').length;
      c.innerHTML=`<div class="content-scroll"><div class="bento-wrap">${hd('字数统计','各篇字数 · 目标 '+S_META.target+'/篇 · 红黄为异常')}<div class="bento-grid">
        <div class="bento-card bento-lg">${mu}<div class="bc-label">各篇字数分布</div><div class="bar-chart">${S_PIECES.map(x=>`<div class="bar ${x.dot==='red'?'hot':x.dot==='yellow'?'warn':''}" style="height:${x.words/mx*100}%"><span class="v">${x.words}</span></div>`).join('')}</div><div class="bc-bars-labels">${S_PIECES.map(x=>`<span>第${x.no}篇</span>`).join('')}</div></div>
        <div class="bento-card">${mu}<div class="bc-label">目标/篇</div><div class="bc-stat">${S_META.target}</div></div>
        <div class="bento-card">${mu}<div class="bc-label">总字数</div><div class="bc-stat">${sum.toLocaleString()}</div></div>
        <div class="bento-card">${mu}<div class="bc-label">平均/篇</div><div class="bc-stat">${avg}</div></div>
        <div class="bento-card">${mu}<div class="bc-label">异常篇数</div><div class="bc-stat" style="color:var(--cinnabar)">${bad}</div></div>
        <div class="bento-card bento-action"><div class="bc-label">各篇明细</div><div class="bc-list">${S_PIECES.map(x=>`<div class="bc-list-row" data-no="${x.no}"><span class="dot ${x.dot}"></span><span>第${x.no}篇 · ${x.title}</span><span class="lr-sub">${x.words} 字</span></div>`).join('')}</div></div>
      </div></div></div>`;
      c.querySelectorAll('[data-no]').forEach(x=>x.onclick=()=>{state.piece=Number(x.dataset.no);state.ov='a_piece';renderOvNav();renderOvMid();renderOvRight();renderStatus();});
      return;
    }
    if(id==='o3'){
      const pcs=S_PIECES.map(p=>({no:p.no,title:p.title,pct:Math.min(Math.round(p.words/S_META.target*100),100),words:p.words}));
      const avg=Math.round(pcs.reduce((s,p)=>s+p.pct,0)/pcs.length);
      const hi=pcs.reduce((a,b)=>b.pct>a.pct?b:a),lo=pcs.reduce((a,b)=>b.pct<a.pct?b:a);
      c.innerHTML=`<div class="content-scroll"><div class="bento-wrap">${hd('完成度','各篇字数完成度 · 目标 '+S_META.target+'/篇')}<div class="bento-grid">
        <div class="bento-card bento-lg">${mu}<div class="bc-label">平均完成度</div><div class="bc-ring" style="background:conic-gradient(var(--ink-cyan) 0 ${avg}%,color-mix(in srgb,var(--border) 55%,transparent) ${avg}% 100%)"><span>${avg}%</span></div><div class="bc-foot">${pcs.length} 篇 · 目标 ${S_META.target} 字/篇 · 字数达标即完成</div></div>
        <div class="bento-card">${mu}<div class="bc-label">最高</div><div class="bc-stat">${hi.pct}<span>%</span></div><div class="bc-sub">${hi.title}</div></div>
        <div class="bento-card">${mu}<div class="bc-label">最低</div><div class="bc-stat" style="color:var(--ochre)">${lo.pct}<span>%</span></div><div class="bc-sub">${lo.title}</div></div>
        <div class="bento-card bento-c2 bento-r2 scroll">${mu}<div class="bc-label">各篇完成度</div><div style="margin-top:10px">${pcs.map(p=>`<div class="bc-prog-row"><div class="bc-prog-head"><span>第${p.no}篇 · ${p.title}</span><span style="color:var(--text-2)">${p.words} / ${S_META.target} · ${p.pct}%</span></div><div class="progress"><div style="width:${p.pct}%"></div></div></div>`).join('')}</div></div>
      </div></div></div>`;
      return;
    }
    if(id==='o4'){
      const heat=[0,1,0,0,1,0,1,1,0,0,1,1,0,1];
      const days=heat.filter(h=>h).length;
      c.innerHTML=`<div class="content-scroll"><div class="bento-wrap">${hd('写作日历','近 14 日 · 每日定稿篇数')}<div class="bento-grid">
        <div class="bento-card bento-lg">${mu}<div class="bc-label">近 14 日热力</div><div class="bc-heat">${heat.map(h=>`<div style="opacity:${0.12+h*0.78}">${h?'·':''}</div>`).join('')}</div></div>
        <div class="bento-card">${mu}<div class="bc-label">定稿天数</div><div class="bc-stat">${days}<span>/14</span></div></div>
        <div class="bento-card">${mu}<div class="bc-label">定稿篇数</div><div class="bc-stat">${heat.reduce((s,h)=>s+h,0)}</div></div>
        <div class="bento-card bento-action"><div class="bc-label">说明</div><div style="font-size:12px;color:var(--text-2);line-height:1.7;margin-top:8px">色深表示当日定稿篇数 · 短篇集以「篇」为定稿单位 · 空白为未动笔日。保持节奏，避免长断档。</div></div>
      </div></div></div>`;
      return;
    }
    if(id==='o5'){
      const ev=[{d:'今天',t:'篇定稿',m:'第3篇·镜中人 3,960 字',cc:'green'},{d:'昨天',t:'伏笔回收',m:'十年前的车票 已闭环',cc:'cyan'},{d:'昨天',t:'篇开稿',m:'第3篇·镜中人',cc:'yellow'},{d:'2天前',t:'篇定稿',m:'第2篇·夜班 5,410 字',cc:'green'}];
      c.innerHTML=`<div class="content-scroll"><div class="bento-wrap">${hd('近期动态','事件流')}<div class="bento-grid">
        <div class="bento-card bento-c2 bento-r2 scroll">${mu}<div class="bc-label">事件流</div><div class="bc-ev">${ev.map(e=>`<div class="bc-ev-row"><span class="dot ${e.cc}"></span><span class="er-time">${e.d}</span><span class="er-txt"><b style="font-weight:600">${e.t}</b> · ${e.m}</span></div>`).join('')}</div></div>
        <div class="bento-card">${mu}<div class="bc-label">本周事件</div><div class="bc-stat">${ev.length}</div></div>
        <div class="bento-card">${mu}<div class="bc-label">定稿</div><div class="bc-stat" style="color:var(--ink-cyan)">${ev.filter(e=>e.t.includes('定稿')).length}</div></div>
        <div class="bento-card">${mu}<div class="bc-label">伏笔</div><div class="bc-stat" style="color:var(--ochre)">${ev.filter(e=>e.t.includes('伏笔')).length}</div></div>
      </div></div></div>`;
      return;
    }
    if(id==='a_health'){
      const SH=S_PIECES.map(p=>{const recv=Math.round(p.payoffs.filter(e=>!e.unresolved).length/p.payoffs.length*100);const emoPeak=Math.max(...p.emo.map(e=>e[2]));const score=Math.round(Math.min(p.words/S_META.target,1)*30+(p.setups.length>=3?25:p.setups.length*8)+recv/100*25+(emoPeak>=7?20:emoPeak*2.5));return {no:p.no,title:p.title,recv,emoPeak,score};});
      const tot=Math.round(SH.reduce((s,x)=>s+x.score,0)/SH.length);
      const top=SH.reduce((a,b)=>b.score>a.score?b:a),low=SH.reduce((a,b)=>b.score<a.score?b:a);
      c.innerHTML=`<div class="content-scroll"><div class="bento-wrap">${hd('体检 · 短篇集','各篇综合 · 情绪/反转/伏笔/字数 四维')}<div class="bento-grid">
        <div class="bento-card bento-lg">${mu}<div class="bc-label">集子均分</div><div class="bc-ring" style="background:conic-gradient(var(--ochre) 0 ${tot}%,color-mix(in srgb,var(--border) 55%,transparent) ${tot}% 100%)"><span>${tot}</span></div><div class="bc-foot">${SH.length} 篇 · 四维加权 · 右栏各篇明细</div></div>
        <div class="bento-card">${mu}<div class="bc-label">最高</div><div class="bc-stat" style="color:var(--ink-cyan)">${top.score}</div><div class="bc-sub">${top.title}</div></div>
        <div class="bento-card">${mu}<div class="bc-label">最低</div><div class="bc-stat" style="color:var(--cinnabar)">${low.score}</div><div class="bc-sub">${low.title}</div></div>
        <div class="bento-card bento-full"><div class="bc-label">各篇四维</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:12px">${SH.map(p=>{const col=p.score>=80?'var(--ink-cyan)':p.score>=70?'var(--ochre)':'var(--cinnabar)';return `<div style="display:flex;flex-direction:column;align-items:center;gap:5px;padding:12px 8px;border-radius:12px;background:color-mix(in srgb,var(--panel) 38%,transparent)"><div class="ring on-panel" style="width:56px;height:56px;background:conic-gradient(${col} 0 ${p.score}%,var(--border) ${p.score}% 100%)"><span class="ring-txt" style="font-size:13px">${p.score}</span></div><div style="font-size:12px;color:var(--ink);font-weight:500">第${p.no}篇 · ${p.title}</div><div style="font-size:10px;color:var(--text-3)">峰值 ${p.emoPeak} · 回收 ${p.recv}%</div></div>`}).join('')}</div></div>
      </div></div></div>`;
      return;
    }
    if(id==='a_rhythm'){
      const peaks=S_PIECES.map(p=>({title:p.title,pk:Math.max(...p.emo.map(e=>e[2]))}));
      const mxp=Math.max(...peaks.map(p=>p.pk)),avgp=Math.round(peaks.reduce((s,p)=>s+p.pk,0)/peaks.length);
      c.innerHTML=`<div class="content-scroll"><div class="bento-wrap">${hd('节奏 · 情绪起伏','各篇情绪峰值 · 短篇靠情绪曲线立节奏')}<div class="bento-grid">
        <div class="bento-card bento-lg">${mu}<div class="bc-label">各篇情绪峰值</div><div class="bar-chart">${peaks.map(p=>`<div class="bar ${p.pk>=9?'hot':p.pk>=7?'warn':''}" style="height:${p.pk/mxp*100}%"><span class="v">${p.pk}</span></div>`).join('')}</div><div class="bc-bars-labels">${peaks.map(p=>`<span>${p.title}</span>`).join('')}</div></div>
        <div class="bento-card">${mu}<div class="bc-label">最高峰值</div><div class="bc-stat" style="color:var(--cinnabar)">${mxp}</div></div>
        <div class="bento-card">${mu}<div class="bc-label">平均峰值</div><div class="bc-stat">${avgp}</div></div>
        <div class="bento-card bento-action"><div class="bc-label">诊断</div><div style="font-size:12.5px;color:var(--text-2);line-height:1.8;margin-top:8px">第3篇·镜中人情绪峰值 10（惊惧），张力最强；第1篇峰值 9 收于释然 6，反差到位。建议第2篇高潮后余寒可再压低半档，增强余韵。</div></div>
      </div></div></div>`;
      return;
    }
  }
  if(id==='o1'){
    const cur=SHELF_BOOKS.find(b=>b.name===state.currentBookName)||SHELF_BOOKS.find(b=>b.kind==='long')||SHELF_BOOKS[0];
    c.innerHTML=`<div class="content-scroll"><div class="bento-wrap"><div class="bento-head"><h1 class="bento-title">${cur.name} · 作品概要</h1><div class="bento-sub">${cur.genre||'长篇'} · 草稿阶段 · 共 ${cur.chapters||5} 章 · 单主视角</div></div>
      <div class="bento-grid">
        <div class="bento-card bento-lg"><div class="bc-menu" title="操作">⋮</div><div class="bc-label">总体完成度</div><div class="bc-ring"><span>61%</span></div><div class="bc-foot">正文 5/40 章 · 大纲至第 30 章 · 设定 3 项 · 体检均分 78</div><div class="bc-progress"><div style="width:61%"></div></div></div>
        <div class="bento-card"><div class="bc-menu" title="操作">⋮</div><div class="bc-label">总字数</div><div class="bc-stat">9,770</div></div>
        <div class="bento-card"><div class="bc-menu" title="操作">⋮</div><div class="bc-label">章节进度</div><div class="bc-stat">5<span>/40</span></div></div>
        <div class="bento-card"><div class="bc-menu" title="操作">⋮</div><div class="bc-label">账本条目</div><div class="bc-stat">6</div></div>
        <div class="bento-card"><div class="bc-menu" title="操作">⋮</div><div class="bc-label">体检均分</div><div class="bc-stat">78</div></div>
        <div class="bento-card bento-md"><div class="bc-menu" title="操作">⋮</div><div class="bc-label">近 7 日字数</div><div class="bc-bars">${[820,1600,0,2240,1850,1980,1280].map(v=>`<div class="bc-bar" style="height:${Math.max(v/2240*100,4)}%" title="${v} 字"></div>`).join('')}</div></div>
        <div class="bento-card bento-action"><div class="bc-label">快速操作</div><div class="bc-btns"><button class="neo-btn">✍ 继续写作</button><button class="neo-btn">🩺 体检</button><button class="neo-btn">📋 大纲</button></div></div>
      </div></div></div>`;
  }else if(id==='o2'){
    const mx=Math.max(...CHAPTERS.map(x=>x.words));
    const sum=CHAPTERS.reduce((s,x)=>s+x.words,0),avg=Math.round(sum/CHAPTERS.length),bad=CHAPTERS.filter(x=>x.dot==='red'||x.dot==='yellow').length;
    c.innerHTML=`<div class="content-scroll"><div class="bento-wrap">${hd('字数统计','各章字数 · 目标 2,000/章 · 红黄为异常')}<div class="bento-grid">
      <div class="bento-card bento-lg">${mu}<div class="bc-label">各章字数分布</div><div class="bar-chart">${CHAPTERS.map(x=>`<div class="bar ${x.dot==='red'?'hot':x.dot==='yellow'?'warn':''}" style="height:${x.words/mx*100}%"><span class="v">${x.words}</span></div>`).join('')}</div><div class="bc-bars-labels">${CHAPTERS.map(x=>`<span>${x.name.split(' · ')[0]}</span>`).join('')}</div></div>
      <div class="bento-card">${mu}<div class="bc-label">目标/章</div><div class="bc-stat">2,000</div></div>
      <div class="bento-card">${mu}<div class="bc-label">总字数</div><div class="bc-stat">${sum.toLocaleString()}</div></div>
      <div class="bento-card">${mu}<div class="bc-label">平均/章</div><div class="bc-stat">${avg}</div></div>
      <div class="bento-card">${mu}<div class="bc-label">异常章数</div><div class="bc-stat" style="color:var(--cinnabar)">${bad}</div></div>
      <div class="bento-card bento-action"><div class="bc-label">各章明细</div><div class="bc-list">${CHAPTERS.map(x=>`<div class="bc-list-row" data-id="${x.id}"><span class="dot ${x.dot}"></span><span>${x.name}</span><span class="lr-sub">${x.words} 字 · ${x.scene}</span></div>`).join('')}</div></div>
    </div></div></div>`;
    c.querySelectorAll('[data-id]').forEach(x=>x.onclick=()=>{state.mode='edit';state.file=x.dataset.id;render();});
  }else if(id==='o3'){
    const dims=[['正文',61],['大纲',75],['设定',66],['体检',78],['账本',50]];
    const avg=Math.round(dims.reduce((s,d)=>s+d[1],0)/dims.length);
    const hi=dims.reduce((a,b)=>b[1]>a[1]?b:a),lo=dims.reduce((a,b)=>b[1]<a[1]?b:a);
    c.innerHTML=`<div class="content-scroll"><div class="bento-wrap">${hd('完成度','分维度进度')}<div class="bento-grid">
      <div class="bento-card bento-lg">${mu}<div class="bc-label">综合完成度</div><div class="bc-ring" style="background:conic-gradient(var(--ink-cyan) 0 ${avg}%,color-mix(in srgb,var(--border) 55%,transparent) ${avg}% 100%)"><span>${avg}%</span></div><div class="bc-foot">${dims.length} 个维度 · 综合 · 右栏查看明细</div></div>
      <div class="bento-card">${mu}<div class="bc-label">最高</div><div class="bc-stat">${hi[1]}<span>%</span></div><div class="bc-sub">${hi[0]}</div></div>
      <div class="bento-card">${mu}<div class="bc-label">最低</div><div class="bc-stat" style="color:var(--ochre)">${lo[1]}<span>%</span></div><div class="bc-sub">${lo[0]}</div></div>
      <div class="bento-card bento-c2 bento-r2 scroll">${mu}<div class="bc-label">各维度进度</div><div style="margin-top:10px">${dims.map(d=>`<div class="bc-prog-row"><div class="bc-prog-head"><span>${d[0]}</span><span style="color:var(--text-2)">${d[1]}%</span></div><div class="progress"><div style="width:${d[1]}%"></div></div></div>`).join('')}</div></div>
    </div></div></div>`;
  }else if(id==='o4'){
    const heat=[20,80,0,40,100,60,90,30,70,0,50,85,45,65];
    const days=heat.filter(h=>h>0).length;
    const total=heat.reduce((s,h)=>s+h,0);
    c.innerHTML=`<div class="content-scroll"><div class="bento-wrap">${hd('写作日历','近 14 日 · 每日字数热力')}<div class="bento-grid">
      <div class="bento-card bento-lg">${mu}<div class="bc-label">近 14 日字数热力</div><div class="bc-heat">${heat.map(h=>`<div style="opacity:${0.12+h/100*0.88}">${h?'·':''}</div>`).join('')}</div></div>
      <div class="bento-card">${mu}<div class="bc-label">动笔天数</div><div class="bc-stat">${days}<span>/14</span></div></div>
      <div class="bento-card">${mu}<div class="bc-label">14日总字数</div><div class="bc-stat">${(total*10).toLocaleString()}</div></div>
      <div class="bento-card bento-action"><div class="bc-label">说明</div><div style="font-size:12px;color:var(--text-2);line-height:1.7;margin-top:8px">色深表示当日字数强度 · 保持每日动笔 · 避免长断档导致节奏流失。</div></div>
    </div></div></div>`;
  }else if(id==='o5'){
    const ev=[{d:'14:06',t:'账本更新',m:'悬念·禁典内容 已新增',cc:'cyan'},{d:'昨天',t:'章节保存',m:'第5章·师兄异动 1,600 字',cc:'green'},{d:'昨天',t:'体检完成',m:'全段体检，发现 2 处节奏失衡',cc:'yellow'},{d:'2天前',t:'大纲扩展',m:'总纲扩展至第三幕',cc:'green'}];
    c.innerHTML=`<div class="content-scroll"><div class="bento-wrap">${hd('近期动态','事件流')}<div class="bento-grid">
      <div class="bento-card bento-c2 bento-r2 scroll">${mu}<div class="bc-label">事件流</div><div class="bc-ev">${ev.map(e=>`<div class="bc-ev-row"><span class="dot ${e.cc}"></span><span class="er-time">${e.d}</span><span class="er-txt"><b style="font-weight:600">${e.t}</b> · ${e.m}</span></div>`).join('')}</div></div>
      <div class="bento-card">${mu}<div class="bc-label">本周事件</div><div class="bc-stat">${ev.length}</div></div>
      <div class="bento-card">${mu}<div class="bc-label">章节</div><div class="bc-stat" style="color:var(--ink-cyan)">${ev.filter(e=>e.t.includes('章节')).length}</div></div>
      <div class="bento-card">${mu}<div class="bc-label">体检</div><div class="bc-stat" style="color:var(--ochre)">${ev.filter(e=>e.t.includes('体检')).length}</div></div>
    </div></div></div>`;
  }else if(id==='a_health'){
    const tot=Math.round(HEALTH.reduce((s,h)=>s+h.score,0)/HEALTH.length);
    const pending=HEALTH.reduce((s,h)=>s+(h.issues||[]).filter(i=>i.sev!=='green').length,0);
    const healthy=HEALTH.filter(h=>!h.count).length;
    c.innerHTML=`<div class="content-scroll"><div class="bento-wrap">${hd('体检 · 总览','全段体检均分 · 各维度评分')}<div class="bento-grid">
      <div class="bento-card bento-lg">${mu}<div class="bc-label">总体均分</div><div class="bc-ring" style="background:conic-gradient(var(--ochre) 0 ${tot}%,color-mix(in srgb,var(--border) 55%,transparent) ${tot}% 100%)"><span>${tot}</span></div><div class="bc-foot">${HEALTH.length} 个维度 · ${pending} 项待处理 · 右栏查看问题明细</div></div>
      <div class="bento-card">${mu}<div class="bc-label">健康维度</div><div class="bc-stat" style="color:var(--ink-cyan)">${healthy}<span>/${HEALTH.length}</span></div></div>
      <div class="bento-card">${mu}<div class="bc-label">待处理</div><div class="bc-stat" style="color:var(--ochre)">${pending}</div></div>
      <div class="bento-card bento-full"><div class="bc-label">各维度评分</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:12px">${HEALTH.map(h=>{const col=h.score>=80?'var(--ink-cyan)':h.score>=70?'var(--ochre)':'var(--cinnabar)';return `<div style="display:flex;flex-direction:column;align-items:center;gap:5px;padding:12px 8px;border-radius:12px;background:color-mix(in srgb,var(--panel) 38%,transparent)"><div class="ring on-panel" style="width:58px;height:58px;background:conic-gradient(${col} 0 ${h.score}%,var(--border) ${h.score}% 100%)"><span class="ring-txt" style="font-size:13px">${h.score}</span></div><div style="font-size:12px;color:var(--ink);font-weight:500">${h.name}</div><div style="font-size:10px;color:var(--text-3)">${h.count?h.count+' 处':'健康'}</div></div>`}).join('')}</div></div>
    </div></div></div>`;
  }else if(id==='a_rhythm'){
    const mx=Math.max(...CHAPTERS.map(x=>x.words));
    const lowC=CHAPTERS.reduce((a,b)=>b.words<a.words?b:a);
    const avg=Math.round(CHAPTERS.reduce((s,x)=>s+x.words,0)/CHAPTERS.length);
    c.innerHTML=`<div class="content-scroll"><div class="bento-wrap">${hd('节奏 · 字数曲线','各章字数走势 · 红黄为异常')}<div class="bento-grid">
      <div class="bento-card bento-lg">${mu}<div class="bc-label">各章字数曲线</div><div class="bar-chart">${CHAPTERS.map(x=>`<div class="bar ${x.dot==='red'?'hot':x.dot==='yellow'?'warn':''}" style="height:${x.words/mx*100}%"><span class="v">${x.words}</span></div>`).join('')}</div><div class="bc-bars-labels">${CHAPTERS.map(x=>`<span>${x.name.split(' · ')[0]}</span>`).join('')}</div></div>
      <div class="bento-card">${mu}<div class="bc-label">最低章</div><div class="bc-stat" style="color:var(--cinnabar)">${lowC.words}</div><div class="bc-sub">${lowC.name.split(' · ')[0]}</div></div>
      <div class="bento-card">${mu}<div class="bc-label">平均/章</div><div class="bc-stat">${avg}</div></div>
      <div class="bento-card bento-action"><div class="bc-label">诊断</div><div style="font-size:12.5px;color:var(--text-2);line-height:1.8;margin-top:8px">第5章字数偏低（1,600），第3-5章连续悬念叠加，建议第6章给一层揭示缓解疲劳。</div></div>
    </div></div></div>`;
  }else if(id==='a_ledger'){
    const LG=state.book==='short'?S_LEDGER:LEDGER;
    const red=LG.filter(l=>l.dot==='red').length,yellow=LG.filter(l=>l.dot==='yellow').length,green=LG.filter(l=>l.dot==='green').length;
    c.innerHTML=`<div class="content-scroll"><div class="bento-wrap">${hd('账本 · 总览',(state.book==='short'?S_META.name+' · ':'')+'伏笔 / 悬念 / 提及 · 状态分布')}<div class="bento-grid">
      <div class="bento-card">${mu}<div class="bc-label">未回收</div><div class="bc-stat" style="color:var(--cinnabar)">${red}</div></div>
      <div class="bento-card">${mu}<div class="bc-label">待揭示</div><div class="bc-stat" style="color:var(--ochre)">${yellow}</div></div>
      <div class="bento-card">${mu}<div class="bc-label">已呼应</div><div class="bc-stat" style="color:var(--ink-cyan)">${green}</div></div>
      <div class="bento-card">${mu}<div class="bc-label">总条目</div><div class="bc-stat">${LG.length}</div></div>
      <div class="bento-card bento-action"><div class="bc-label">说明</div><div style="font-size:12.5px;color:var(--text-2);line-height:1.8;margin-top:8px">右栏为全部账本条目，点击任一条目可在此查看埋点 → 呼应 → 回收的完整追踪。</div></div>
    </div></div></div>`;
  }
}
function renderLedgerTrace(id){
  const LG=state.book==='short'?S_LEDGER:LEDGER;
  const l=LG.find(x=>x.id===id)||LG[0];
  const stCls=l.dot==='gray'?'gray':(l.dot==='green'?'green':l.dot);
  el('content').innerHTML=`<div class="content-scroll"><div class="bento-wrap"><div class="bento-head"><div style="display:flex;align-items:center;gap:10px"><span class="btn" id="bkLedger" style="font-size:11px">← 返回</span><h1 class="bento-title" style="margin:0">${l.type} · ${l.name}</h1><span class="tag ${stCls}">${l.st}</span></div><div class="bento-sub">首次出现：${l.ch}</div></div>
    <div class="bento-grid">
      <div class="bento-card bento-lg scroll"><div class="bc-menu">⋮</div><div class="bc-label">追踪时间线 · 埋点 → 呼应 → 回收</div>
        <div class="tl">
          <div class="tl-item ${l.dot==='red'?'red':l.dot==='yellow'?'yellow':''}"><div class="tl-t">埋点 · ${l.ch}</div><div class="tl-h">伏笔 / 悬念植入</div><div class="tl-q">${l.bury}</div></div>
          <div class="tl-item ${l.echo==='—'?'gray':'green'}"><div class="tl-t">呼应</div><div class="tl-h">${l.echo==='—'?'尚无呼应':'线索接续'}</div>${l.echo!=='—'?`<div class="tl-q">${l.echo}</div>`:''}</div>
          <div class="tl-item ${l.recv==='—'?'gray':'green'}"><div class="tl-t">回收</div><div class="tl-h">${l.recv==='—'?'等待回收':'已回收'}</div>${l.recv!=='—'?`<div class="tl-q">${l.recv}</div>`:''}</div>
        </div>
      </div>
      <div class="bento-card bento-c2 bento-r2 scroll"><div class="bc-menu">⋮</div><div class="bc-label">处置建议</div><div style="font-size:13px;line-height:1.8;color:var(--text-2);margin-top:6px">${l.sugg}</div><div class="bc-btns" style="margin-top:14px"><button class="neo-btn" id="editHere">✍ 在编辑器打开</button><button class="neo-btn">✓ 标记为已回收</button></div></div>
    </div></div></div>`;
  el('bkLedger').onclick=()=>{state.ledgerDetail=null;renderOvMid();renderOvRight();};
  el('editHere').onclick=()=>{const ch=l.ch.match(/第\d章/);state.mode='edit';state.file=ch?ch[0].replace('第','ch').replace('章',''):'';if(!CHAPTERS.find(x=>x.id===state.file))state.file='ch3';render();};
}
function renderOvRight(){
  const id=state.ov,r=el('rightctx');
  if(id==='a_piece'){
    r.innerHTML=`<div class="card"><div class="card-title">篇列表 · 共 ${S_PIECES.length} 篇</div>${S_PIECES.map(p=>`<div class="ledger-item click" data-no="${p.no}"><span class="dot ${p.dot}"></span><div><b>第${p.no}篇 · ${p.title}</b><div class="desc">${p.targetEmo} · ${p.words.toLocaleString()}字</div></div></div>`).join('')}</div>`;
    r.querySelectorAll('.ledger-item.click').forEach(x=>x.onclick=()=>{state.piece=Number(x.dataset.no);renderPieceDetail();renderOvRight();renderStatus();});
    return;
  }
  if(state.book==='short'&&!['o1','a_piece','a_ledger'].includes(id)){
    const labels={o2:'各篇字数',o3:'各篇完成度',o4:'近14日',o5:'分类',a_health:'四维明细',a_rhythm:'各篇峰值'};
    r.innerHTML=`<div class="card"><div class="card-title">${labels[id]||'各篇'}</div>${S_PIECES.map(p=>{const pk=Math.max(...p.emo.map(e=>e[2]));const recv=Math.round(p.payoffs.filter(e=>!e.unresolved).length/p.payoffs.length*100);const pct=Math.min(Math.round(p.words/S_META.target*100),100);const v=id==='a_rhythm'?'峰值 '+pk:id==='a_health'?'回收 '+recv+'%':id==='o5'?'情绪 '+p.emo[p.emo.length-1][1]:pct+'%';return `<div class="kv click" data-no="${p.no}"><span class="k"><span class="dot ${p.dot}" style="display:inline-block;margin-right:7px"></span>第${p.no}篇 · ${p.title}</span><span class="v">${v}</span></div>`}).join('')}</div>`;
    r.querySelectorAll('.kv.click').forEach(x=>x.onclick=()=>{state.piece=Number(x.dataset.no);state.ov='a_piece';renderOvNav();renderOvMid();renderOvRight();renderStatus();});
    return;
  }
  if(id==='o1'){
    r.innerHTML=`<div class="card"><div class="card-title">关键指标</div><div class="kv"><span class="k">总字数</span><span class="v">9,770</span></div><div class="kv"><span class="k">章节</span><span class="v">5 / 40</span></div><div class="kv"><span class="k">完成度</span><span class="v cyan">61%</span></div><div class="kv"><span class="k">账本</span><span class="v">6</span></div><div class="kv"><span class="k">体检均分</span><span class="v">78</span></div><div class="kv"><span class="k">设定</span><span class="v">3 项</span></div></div>`;
  }else if(id==='o2'){
    r.innerHTML=`<div class="card"><div class="card-title">各章字数</div>${CHAPTERS.map(c=>`<div class="kv click"><span class="k"><span class="dot ${c.dot}" style="display:inline-block;margin-right:7px"></span>${c.name.split(' · ')[0]}</span><span class="v">${c.words}</span></div>`).join('')}</div>`;
    r.querySelectorAll('.kv.click').forEach((x,i)=>x.onclick=()=>{state.mode='edit';state.file=CHAPTERS[i].id;render();});
  }else if(id==='o3'){
    r.innerHTML=`<div class="card"><div class="card-title">维度明细</div>${[['正文',61],['大纲',75],['设定',66],['体检',78],['账本',50]].map(x=>`<div class="kv"><span class="k">${x[0]}</span><span class="v">${x[1]}%</span></div>`).join('')}</div>`;
  }else if(id==='o4'){
    r.innerHTML=`<div class="card"><div class="card-title">本周字数</div><div class="kv"><span class="k">周一</span><span class="v">820</span></div><div class="kv"><span class="k">周二</span><span class="v">1,600</span></div><div class="kv"><span class="k">周三</span><span class="v">0</span></div><div class="kv"><span class="k">周四</span><span class="v">2,240</span></div><div class="kv"><span class="k">周五</span><span class="v">1,850</span></div><div class="kv"><span class="k">周六</span><span class="v">1,980</span></div><div class="kv"><span class="k">周日</span><span class="v">1,280</span></div></div>`;
  }else if(id==='o5'){
    r.innerHTML=`<div class="card"><div class="card-title">分类</div><div class="kv"><span class="k">账本</span><span class="v">2</span></div><div class="kv"><span class="k">章节</span><span class="v">3</span></div><div class="kv"><span class="k">体检</span><span class="v">1</span></div><div class="kv"><span class="k">大纲</span><span class="v">2</span></div></div>`;
  }else if(id==='a_health'){
    r.innerHTML=`<div class="card"><div class="card-title">问题清单 · 全部</div>${HEALTH.flatMap(h=>h.issues.map(i=>({h,i}))).filter(x=>x.i.sev!=='green').map(x=>`<div class="ledger-item"><span class="dot ${x.i.sev}"></span><div><b>${x.i.ch}</b><div class="desc">${x.i.d}</div></div></div>`).join('')||'<div style="font-size:12px;color:var(--text-2)">无待处理问题</div>'}</div>`;
  }else if(id==='a_rhythm'){
    r.innerHTML=`<div class="card"><div class="card-title">各章数据</div>${CHAPTERS.map(c=>`<div class="kv"><span class="k"><span class="dot ${c.dot}" style="display:inline-block;margin-right:7px"></span>${c.name.split(' · ')[0]}</span><span class="v">${c.words} · ${c.scene}</span></div>`).join('')}</div>`;
  }else if(id==='a_ledger'){
    const LG=state.book==='short'?S_LEDGER:LEDGER;
    const items=LG.map(l=>`<div class="ledger-item click" data-lid="${l.id}"><span class="dot ${l.dot}"></span><div><b>${l.type}·${l.name}</b><div class="desc">${l.ch} · ${l.st}</div></div></div>`).join('');
    r.innerHTML='<div class="card"><div class="card-title">账本条目 · 全部 <span style="color:var(--text-3)">'+LG.length+'</span></div>'+items+'</div>';
    r.querySelectorAll('.ledger-item.click').forEach(x=>x.onclick=()=>{state.ledgerDetail=x.dataset.lid;renderOvMid();renderOvRight();});
  }else if(id==='a_relations'){
    var nList=RELATIONS.nodes.map(function(n){var col=relNodeColor(n.dot);return'<div class="kv click" data-rid="'+n.id+'"><span class="k"><span class="dot" style="display:inline-block;margin-right:6px;background:'+col+'"></span>'+n.name+'</span><span class="v cyan">'+n.role+'</span></div>';}).join('');
    r.innerHTML='<div class="card"><div class="card-title">节点</div><div style="font-size:12px;color:var(--text-2);line-height:1.7">点击图中角色查看详情与关联</div></div><div class="card"><div class="card-title">全角色</div>'+nList+'</div>';
    r.querySelectorAll('.kv.click[data-rid]').forEach(function(x){x.onclick=function(){relSel=x.dataset.rid;renderRelations();renderRelRight();};});
  }
}

