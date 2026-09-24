class SonosRemoteCard extends HTMLElement {
  setConfig(config) {
    this.config = config || {};
    this._view = this._view || "now";
    this._selectedRooms = this._selectedRooms || new Set();
    this._maResults = this._maResults || null;
    this._recent = this._recent || null;
    this._recentLoading = false;
    this._maLoading = false;
    this._maCategory = this._maCategory || null;
    this._maMenu = null;
    this._scrollTop = this._scrollTop || {};
    this._pickerScrollTop = this._pickerScrollTop || {now:0,music:0,queue:0};
    this._queue = this._queue || null;
    this._queueLoading = false;
    this._queuePlayer = this._queuePlayer || null;
    this._progressTimer = null;
    this._backendInfo = this._backendInfo || null;
    this._volumeSendTimer = null;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
  }
  set hass(hass) {
    this._hass = hass;
    this._players = this._backendInfo?.players?.map(p=>hass.states[p.entity_id]).filter(Boolean) || this._discoverPlayers(hass);
    if (!this._backendInfo && !this._infoLoading) this._loadBackendInfo();
    if (!this._recent && !this._recentLoading) this._loadRecent();
    this._selected = this._selected && hass.states[this._selected]
      ? this._selected : (this.config.default_player || this._players[0]?.entity_id);
    if (!this._selectedRooms.size) (this._hass.states[this._selected]?.attributes?.group_members || [this._selected]).filter(Boolean).forEach(id => this._selectedRooms.add(id));
    const active=this.shadowRoot?.activeElement;
    const interactingWithPicker=this._pickerOpen && !!this.shadowRoot?.querySelector("#playerlist.open");
    // Rooms is a long interactive selection surface. Rebuilding it for every
    // Sonos state tick destroys the scroll container and causes iOS/HA to jump.
    // Keep its DOM stable; room controls update themselves in place and Apply
    // performs the next full render after the grouping action completes.
    const interactingWithRooms=this._view==="rooms";
    // Music is also a long scrollable selection surface. Rebuilding it for
    // routine HA/Sonos state ticks resets its scroll container just like Rooms.
    // Keep the Music DOM stable for the entire time that view is open; searches,
    // category changes, player selection, and playback actions render explicitly.
    const interactingWithMusic=this._view==="music";
    // Queue is another long scrollable surface. Sonos/MA state ticks must not
    // rebuild it while it is open or the scroll container jumps back to top.
    // Explicit queue actions and room changes already refresh it themselves.
    const interactingWithQueue=this._view==="queue";
    if(!interactingWithRooms && !interactingWithMusic && !interactingWithQueue && !interactingWithPicker) this._render();
  }
  getCardSize() { return 8; }
  async _loadBackendInfo() {
    if (!this._hass || this._infoLoading) return;
    this._infoLoading = true;
    try {
      this._backendInfo = await this._hass.callWS({type:"sonos_remote/info"});
      this._players = (this._backendInfo.players||[]).map(p=>this._hass.states[p.entity_id]).filter(Boolean);
    } catch(e) { console.warn("Sonos Remote backend info unavailable",e); }
    finally { this._infoLoading=false; this._render(); }
  }
  async _loadRecent(force=false) {
    if(!this._hass || this._recentLoading || (!force && this._recent)) return;
    this._recentLoading=true;
    try { this._recent=await this._hass.callWS({type:"sonos_remote/recently_played",limit:10}); }
    catch(e) { this._recent={available:false,items:[]}; }
    finally { this._recentLoading=false; if(this._view==="music") this._render(); }
  }
  _recentHtml() {
    const items=this._recent?.available?(this._recent.items||[]):[];
    if(!items.length)return "";
    return `<div class="sectiontitle">Recently Played</div>`+items.map(item=>{const uri=item.uri||item.media_content_id||"";const type=item.media_type||"track";const name=item.name||item.title||"Unknown";const sub=item.artist||item.album||String(type).replaceAll("_"," ");return `<div class="mawrap"><button class="fav maitem" data-recent-uri="${this._esc(uri)}" data-recent-type="${this._esc(type)}"><span class="favart"><ha-icon icon="mdi:history"></ha-icon></span><span><span class="favname">${this._esc(name)}</span><span class="favsub">${this._esc(sub||"Music Assistant")}</span></span></button><button class="maoptions" data-ma-options="${this._esc(uri)}" data-ma-type="${this._esc(type)}" aria-label="Playback options"><ha-icon icon="mdi:dots-vertical"></ha-icon></button>${this._maMenu===uri?`<div class="maactionmenu"><button data-ma-action="play" data-ma-uri="${this._esc(uri)}" data-ma-type="${this._esc(type)}">Play Now</button><button data-ma-action="next" data-ma-uri="${this._esc(uri)}" data-ma-type="${this._esc(type)}">Play Next</button><button data-ma-action="add" data-ma-uri="${this._esc(uri)}" data-ma-type="${this._esc(type)}">Add to End of Queue</button></div>`:""}</div>`}).join("");
  }
  async _searchMA(query, category=null) {
    query=(query||"").trim();
    if (!query || this._maLoading) return;
    this._lastSearch=query;
    this._maCategory=category;
    this._maLoading=true;
    this._render();
    try { this._maResults=await this._hass.callWS({type:"sonos_remote/search",query,limit:category?20:5,media_type:category||undefined}); }
    catch(e) { this._maResults={error:e?.message||"Music Assistant search failed"}; }
    finally { this._maLoading=false; this._render(); }
  }
  _maResultsHtml() {
    if(this._maLoading)return `<div class="mahint">Searching Music Assistant…</div>`;
    if(!this._maResults)return `<div class="mahint">Search Apple Music, Spotify and your Music Assistant library.</div>`;
    if(this._maResults.error)return `<div class="mahint">${this._esc(this._maResults.error)}</div>`;
    const groups=[["tracks","Tracks","track","mdi:music-note"],["albums","Albums","album","mdi:album"],["artists","Artists","artist","mdi:account-music"],["playlists","Playlists","playlist","mdi:playlist-music"],["radio","Radio","radio","mdi:radio"]];
    let html="";
    if(this._maCategory) html+=`<button class="maback" data-ma-back><ha-icon icon="mdi:chevron-left"></ha-icon> All results</button>`;
    for(const [key,label,type,icon] of groups){
      if(this._maCategory && this._maCategory!==type) continue;
      const items=this._maResults[key]||[];
      if(!items.length)continue;
      html+=`<div class="sectionrow"><div class="sectiontitle">${label}</div>${!this._maCategory?`<button class="seeall" data-ma-seeall="${type}">See All ›</button>`:""}</div>`+
      items.map(item=>{const uri=item.uri||item.media_content_id||"";const provider=uri.includes("://")?uri.split("://")[0]:"Music Assistant";const artist=Array.isArray(item.artists)?item.artists.map(x=>x?.name||x).filter(Boolean).join(", "):(item.artist?.name||item.artist||item.artist_name||"");const album=item.album?.name||item.album||item.album_name||"";const sub=artist||album||provider;return `<div class="mawrap"><button class="fav maitem" data-ma-uri="${this._esc(uri)}" data-ma-type="${type}"><span class="favart"><ha-icon icon="${icon}"></ha-icon></span><span><span class="favname">${this._esc(item.name||item.title||"Unknown")}</span><span class="favsub">${this._esc(sub)}</span></span></button><button class="maoptions" data-ma-options="${this._esc(uri)}" data-ma-type="${type}" aria-label="Playback options"><ha-icon icon="mdi:dots-vertical"></ha-icon></button>${this._maMenu===uri?`<div class="maactionmenu"><button data-ma-action="play" data-ma-uri="${this._esc(uri)}" data-ma-type="${type}">Play Now</button><button data-ma-action="next" data-ma-uri="${this._esc(uri)}" data-ma-type="${type}">Play Next</button><button data-ma-action="add" data-ma-uri="${this._esc(uri)}" data-ma-type="${type}">Add to End of Queue</button></div>`:""}</div>`}).join("");
    }
    return html||`<div class="mahint">No results found.</div>`;
  }
  async _loadQueue(force=false) {
    if(!this._selected || this._queueLoading) return;
    if(!force && this._queuePlayer===this._selected && this._queue) return;
    this._queueLoading=true; this._queuePlayer=this._selected; this._render();
    try { this._queue=await this._hass.callWS({type:"sonos_remote/queue",sonos_entity_id:this._selected,limit:100}); }
    catch(e) { this._queue={error:e?.message||"Unable to load queue"}; }
    finally { this._queueLoading=false; this._render(); }
  }
  async _queueAction(action,itemId=null,index=null) {
    try {
      const msg={type:"sonos_remote/queue_action",sonos_entity_id:this._selected,action};
      if(itemId) msg.item_id=itemId; else if(index!==null) msg.index=index;
      await this._hass.callWS(msg);
      await this._loadQueue(true);
    } catch(e) {
      this.dispatchEvent(new CustomEvent("hass-notification",{detail:{message:e?.message||"Unable to update queue"},bubbles:true,composed:true}));
    }
  }
  _queueHtml() {
    if(this._queueLoading && !this._queue) return `<div class="mahint">Loading queue…</div>`;
    if(this._queue?.error) return `<div class="mahint">${this._esc(this._queue.error)}</div>`;
    const items=this._queue?.items||[];
    if(!items.length) return `<div class="queueempty"><ha-icon icon="mdi:playlist-music"></ha-icon><b>Queue is empty</b><span>Choose music to start a queue for this room.</span></div>`;
    const current=Number(this._queue.current_index);
    return items.map((item,i)=>{
      const media=item.media_item||{};
      const name=media.name||item.media_title||item.name||"Unknown";
      const artists=Array.isArray(media.artists)?media.artists.map(x=>x?.name||x).filter(Boolean).join(", "):(media.artist_str||item.media_artist||item.artist||"");
      const isCurrent=i===current;
      const id=item.queue_item_id||item.item_id||item.id||"";
      return `<div class="qitem ${isCurrent?"current":""}"><button class="qplay" data-qplay="${this._esc(id)}" data-qindex="${i}"><span class="qnum">${isCurrent?'<ha-icon icon="mdi:volume-high"></ha-icon>':i+1}</span><span class="qcopy"><b>${this._esc(name)}</b><small>${this._esc(artists)}</small></span></button><button class="qremove" data-qremove="${this._esc(id)}" data-qindex="${i}" aria-label="Remove"><ha-icon icon="mdi:close"></ha-icon></button></div>`;
    }).join("");
  }
  _discoverPlayers(hass) {
    const configured = this.config.entities || [];
    if (configured.length) return configured.map(id => hass.states[id]).filter(Boolean);
    return Object.values(hass.states).filter(s => s.entity_id.startsWith("media_player.") &&
      (s.attributes.platform === "sonos" || Array.isArray(s.attributes.sonos_group) ||
       (s.attributes.device_class === "speaker" && "group_members" in s.attributes)));
  }
  _groups() {
    const seen=new Set(), groups=[];
    for(const p of this._players||[]) {
      const raw=p.attributes?.group_members||p.attributes?.sonos_group||[p.entity_id];
      const members=[...new Set((raw||[p.entity_id]).filter(id=>this._players.some(x=>x.entity_id===id)))];
      const key=[...members].sort().join("|");
      if(!key||seen.has(key)) continue;
      seen.add(key);
      const leader=members[0]||p.entity_id;
      groups.push({leader,members,names:members.map(id=>this._hass.states[id]?.attributes?.friendly_name||id)});
    }
    return groups;
  }
  _playerChoices() {
    const grouped=new Set(), choices=[];
    for(const g of this._groups()) {
      if(g.members.length>1) {
        g.members.forEach(id=>grouped.add(id));
        choices.push({id:g.leader,label:g.names.join(" + "),sub:`${g.members.length} rooms grouped`,icon:"mdi:speaker-multiple"});
      }
    }
    for(const p of this._players||[]) if(!grouped.has(p.entity_id)) choices.push({id:p.entity_id,label:p.attributes?.friendly_name||p.entity_id,sub:p.state==="playing"?(p.attributes?.media_title||"Playing"):"Not playing",icon:"mdi:speaker"});
    return choices;
  }
  _currentGroup() {
    if(!this._selected) return [];
    const g=this._groups().find(x=>x.members.includes(this._selected));
    return g?.members?.length ? [...g.members] : [this._selected];
  }
  _sameMembers(a,b) {
    if(a.length!==b.length) return false;
    const x=[...a].sort(), y=[...b].sort();
    return x.every((v,i)=>v===y[i]);
  }
  _groupActionLabel() {
    const chosen=[...this._selectedRooms];
    const current=this._currentGroup();
    if(!chosen.length) return "Select Rooms";
    if(this._sameMembers(chosen,current)) return "Group Is Current";
    if(current.length>1) return chosen.length===1 ? "Ungroup Selected Room" : "Update Group";
    return chosen.length>1 ? `Group ${chosen.length} Rooms` : "Select Another Room";
  }
  _call(service, data={}) {
    if (!this._selected) return;
    return this._hass.callService("media_player", service, {entity_id:this._selected, ...data});
  }
  _esc(v) { const d=document.createElement("div"); d.textContent=v||""; return d.innerHTML; }
  _tab(id,icon,label) {
    return `<button class="tab ${this._view===id?"active":""}" data-view="${id}"><ha-icon icon="${icon}"></ha-icon><span>${label}</span></button>`;
  }
  _favoritesHtml() {
    const sensor=Object.values(this._hass.states).find(s=>s.entity_id.startsWith("sensor.")&&s.entity_id.includes("sonos_favorites"));
    const items=sensor?.attributes?.items||{};
    const entries=Object.entries(items);
    if(!entries.length)return '<div class="artist">Enable the Sonos Favorites sensor to show My Sonos favorites here.</div>';
    return entries.map(([id,name])=>`<button class="fav" data-favorite="${this._esc(id)}"><span class="favart"><ha-icon icon="mdi:heart"></ha-icon></span><span><span class="favname">${this._esc(name)}</span><span class="favsub">Sonos Favorite</span></span><ha-icon icon="mdi:play"></ha-icon></button>`).join("");
  }
  _render() {
    if (!this.shadowRoot || !this._hass) return;
    const oldMain=this.shadowRoot.querySelector(".viewscroll");
    if(oldMain) this._scrollTop[this._view]=oldMain.scrollTop;
    const oldPicker=this.shadowRoot.querySelector("#playerlist");
    if(oldPicker) this._pickerScrollTop[this._view]=oldPicker.scrollTop;
    const st=this._hass.states[this._selected], a=st?.attributes||{};
    const title=a.media_title||"Nothing playing", artist=a.media_artist||"", album=a.media_album_name||"";
    const art=a.entity_picture?this._hass.hassUrl(a.entity_picture):"", playing=st?.state==="playing";
    const volume=Math.round((a.volume_level||0)*100);
    const duration=Number(a.media_duration||0);
    let position=Number(a.media_position||0);
    if(playing && a.media_position_updated_at){
      const updated=Date.parse(a.media_position_updated_at);
      if(Number.isFinite(updated)) position+=Math.max(0,(Date.now()-updated)/1000);
    }
    if(duration>0) position=Math.min(duration,position);
    const progress=duration>0?Math.max(0,Math.min(100,(position/duration)*100)):0;
    const fmt=n=>{n=Math.max(0,Math.floor(Number(n)||0));return `${Math.floor(n/60)}:${String(n%60).padStart(2,"0")}`;};
    const members=a.group_members||a.sonos_group||[this._selected].filter(Boolean);
    const rooms=members.map(id=>this._hass.states[id]?.attributes?.friendly_name||id).join(" + ");
    this.shadowRoot.innerHTML=`
    <style>
      :host{display:block} ha-card{height:min(760px,calc(100dvh - 96px));min-height:620px;overflow:hidden;border-radius:22px;background:#111214;color:#f5f5f5;border:0;box-shadow:0 14px 40px rgba(0,0,0,.28);display:flex;flex-direction:column}.viewscroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#4a4d52 transparent}.viewscroll.nowview{overflow-y:hidden}
      .wrap{padding:12px 18px 4px}.top{display:flex;justify-content:center;align-items:center;margin-bottom:8px}.playerpick{display:flex;align-items:center;justify-content:center;gap:5px;padding:5px 8px;margin:0;background:transparent;color:#f5f5f5;font-size:20px;font-weight:700}.playerpick span{max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.picker{display:none;margin:0 0 14px;padding:8px;border-radius:14px;background:#202124}.picker.open{display:block;max-height:240px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#4a4d52 transparent}.pickrow{display:flex;align-items:center;gap:9px;width:100%;padding:9px 10px;border-radius:10px;text-align:left;color:#f5f5f5}.pickrow.active{background:#303236}.pickrow span{flex:1}.art,.placeholder{aspect-ratio:1/1;width:min(100%,300px);margin:0 auto;border-radius:16px;background:#202124}
      .art{object-fit:contain;display:block;background:#111214}.placeholder{display:grid;place-items:center;font-size:64px;opacity:.65}.meta{text-align:center}.progress{margin:8px 0 2px}.progress input{width:100%}.progress.live{margin:13px 0 7px}.liveline{display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:center;color:#8f9297;font-size:10px;letter-spacing:.12em}.liveline span{height:1px;background:#3b3d41}.liveline b{font-weight:700}.times{display:flex;justify-content:space-between;color:#8f9297;font-size:11px}.topcopy{text-align:center;min-width:0}.eyebrow{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#8f9297;font-weight:700}
      h2{margin:10px 0 3px;font-size:24px;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .artist,.album{color:#a9acb1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.album{font-size:13px;margin-top:3px}
      .controls{display:grid;grid-template-columns:1fr 1fr 1.2fr 1fr 1fr;align-items:center;margin:5px 18px 2px}
      button{appearance:none;border:0;background:none;color:inherit;min-height:48px;cursor:pointer}.activecmd{color:var(--primary-color)}.main{width:60px;height:60px;min-height:60px;background:#f5f5f5;color:#111214;border-radius:50%;justify-self:center}.main ha-icon{--mdc-icon-size:28px}.skip ha-icon{--mdc-icon-size:30px}
      .volume{display:grid;grid-template-columns:28px 1fr 38px;gap:8px;align-items:center;margin:0 18px 3px}.volume input{width:100%}
      .group{margin:0 18px 5px;padding:7px 14px;min-height:34px;box-sizing:border-box;border-radius:14px;background:#202124;cursor:pointer}.group small{display:block;color:var(--secondary-text-color);margin-bottom:3px}
      .tabs{flex:0 0 auto;display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid #2a2c2f;background:#151618;padding:7px 4px calc(7px + env(safe-area-inset-bottom));z-index:5}
      .tab{font-size:11px;opacity:.62;display:flex;flex-direction:column;gap:4px;align-items:center}.tab.active{opacity:1;color:#fff}.tab ha-icon{--mdc-icon-size:22px}
      .rooms{padding:18px;min-height:100%;box-sizing:border-box}.roomhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.roomhead h1{margin:0;font-size:28px}.roomsummary{font-size:12px;color:#8f9297;margin:-6px 0 14px}.roomlist{border-top:1px solid #292b2f}.room{display:grid;grid-template-columns:34px minmax(0,1fr);gap:10px;align-items:center;padding:10px 2px;border-bottom:1px solid #292b2f;background:transparent}.check{width:26px;height:26px;min-height:26px;border:1px solid #62656a;border-radius:50%;display:grid;place-items:center}.check.on{background:#f5f5f5;border-color:#f5f5f5;color:#111214}.roommain{min-width:0}.roomline{display:flex;align-items:center;gap:8px}.roomname{font-weight:650;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.roomstate{font-size:11px;color:#8f9297}.roomsub{font-size:12px;color:#8f9297;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}.roomvol{display:grid;grid-template-columns:20px 1fr 30px;gap:7px;align-items:center;margin-top:7px}.roomvol input{width:100%;margin:0}.roomvol span{text-align:right;font-size:11px;color:#8f9297}.roomvol ha-icon{--mdc-icon-size:17px;color:#8f9297}.applybar{position:sticky;bottom:0;padding:12px 0 2px;background:linear-gradient(transparent,#111214 22%)}.apply{width:100%;height:46px;border-radius:23px!important;background:#f5f5f5!important;color:#111214!important;font-weight:700;margin-top:8px}.apply:disabled{opacity:.35;cursor:default}.roomstate:not(:empty){padding:2px 6px;border-radius:8px;background:#25272a}.pickrow small{display:block;color:#8f9297;font-size:11px;margin-top:2px}.pickrow b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .music{padding:18px;min-height:100%;box-sizing:border-box}.music .roomhead{margin-bottom:7px}.music .roomhead h1{color:#f5f5f5}.musicdestlabel{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8f9297;font-weight:700}.music .playerpick{justify-content:flex-start;padding:4px 0 9px;font-size:17px;max-width:100%}.music .picker{margin-bottom:12px}.sectionrow{display:flex;align-items:center;justify-content:space-between;margin-top:18px}.sectionrow .sectiontitle{margin:0 0 10px}.seeall,.maback{min-height:36px;color:#a9acb1;font-size:13px;padding:0 2px}.maback{display:flex;align-items:center;gap:2px;margin:0 0 6px}.maback ha-icon{--mdc-icon-size:18px}.search{display:grid;grid-template-columns:24px 1fr;gap:8px;align-items:center;background:#202124;border:1px solid #2d2f33;border-radius:14px;padding:10px 13px;margin-bottom:16px;color:#a9acb1}.search input{border:0;outline:0;background:transparent;color:#f5f5f5;font:inherit;width:100%}.search input::placeholder{color:#777b81}.sectiontitle{font-size:17px;font-weight:700;margin:18px 0 10px;color:#f5f5f5}.fav{display:grid;grid-template-columns:48px minmax(0,1fr) 28px;gap:10px;align-items:center;width:100%;padding:9px;border-radius:12px;background:#202124;color:#f5f5f5;margin-bottom:7px;text-align:left}.favart{width:48px;height:48px;border-radius:9px;background:#2b2d31;display:grid;place-items:center;color:#d7d8da}.favname{display:block;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.favsub{display:block;font-size:12px;color:#8f9297;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mahint{padding:12px 4px;color:#8f9297;font-size:13px}.maitem{text-align:left;width:100%}.mawrap{position:relative}.mawrap .maitem{padding-right:44px}.maoptions{position:absolute;right:4px;top:50%;transform:translateY(-50%);width:38px;min-height:38px;display:grid;place-items:center;z-index:2}.maoptions ha-icon{--mdc-icon-size:20px}.maactionmenu{position:absolute;right:4px;top:42px;z-index:25;width:180px;background:#202124;border:1px solid #34363a;border-radius:12px;padding:5px;box-shadow:0 12px 30px rgba(0,0,0,.45)}.maactionmenu button{display:block;width:100%;min-height:40px;text-align:left;padding:0 10px;border-radius:8px;font-size:13px}.maactionmenu button:hover{background:#303236}.queue{padding:18px;min-height:100%;box-sizing:border-box}.queue .roomhead{margin-bottom:4px}.queue .playerpick{justify-content:flex-start;padding:4px 0 10px;font-size:17px;max-width:100%}.queue .picker{margin-bottom:12px}.queuehead{display:flex;align-items:center;justify-content:space-between}.clearq{min-height:38px;color:#a9acb1;font-size:13px;padding:0 2px}.qitem{display:grid;grid-template-columns:minmax(0,1fr) 42px;align-items:center;border-bottom:1px solid #292b2f}.qitem.current{background:#1d1f22;border-radius:10px}.qplay{display:grid;grid-template-columns:34px minmax(0,1fr);gap:8px;align-items:center;text-align:left;padding:8px 2px;min-width:0}.qnum{display:grid;place-items:center;color:#8f9297;font-size:12px}.qnum ha-icon{--mdc-icon-size:18px;color:#f5f5f5}.qcopy{min-width:0}.qcopy b,.qcopy small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.qcopy b{font-size:14px}.qcopy small{font-size:12px;color:#8f9297;margin-top:2px}.qremove{min-height:42px;color:#777b81}.qremove ha-icon{--mdc-icon-size:18px}.queueempty{min-height:300px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#8f9297;gap:8px}.queueempty ha-icon{--mdc-icon-size:42px}.queueempty b{color:#f5f5f5}.queueempty span{font-size:13px;max-width:240px}.stub{min-height:100%;box-sizing:border-box;padding:20px}.stub h2{margin-top:0}@media(min-width:600px){ha-card{max-width:430px;margin:auto}}
    </style><ha-card>
    <main class="viewscroll ${this._view==="now"?"nowview":""}">${this._view==="now"?`<div class="wrap"><div class="top"><div class="topcopy"><div class="eyebrow">Now Playing</div><button class="playerpick" id="playerpick"><span>${this._esc(a.friendly_name||"Select Sonos")}</span><ha-icon icon="mdi:chevron-down"></ha-icon></button></div></div><div class="picker ${this._pickerOpen?"open":""}" id="playerlist">${this._playerChoices().map(p=>`<button class="pickrow ${p.id===this._selected?"active":""}" data-select-player="${p.id}"><ha-icon icon="${p.icon}"></ha-icon><span><b>${this._esc(p.label)}</b><small>${this._esc(p.sub)}</small></span>${p.id===this._selected?`<ha-icon icon="mdi:check"></ha-icon>`:""}</button>`).join("")}</div>${art?`<img class="art" src="${art}" alt="">`:`<div class="placeholder">♫</div>`}<div class="meta"><h2>${this._esc(title)}</h2><div class="artist">${this._esc(artist)}</div><div class="album">${this._esc(album)}</div><div class="progress ${duration?"":"live"}">${duration?`<input id="seek" type="range" min="0" max="100" value="${progress}"><div class="times"><span id="elapsed">${fmt(position)}</span><span>${fmt(duration)}</span></div>`:`<div class="liveline"><span></span><b>LIVE</b><span></span></div>`}</div></div></div>
    <div class="controls"><button class="${a.shuffle?"activecmd":""}" data-action="shuffle"><ha-icon icon="mdi:shuffle-variant"></ha-icon></button><button class="skip" data-action="previous"><ha-icon icon="mdi:skip-previous"></ha-icon></button><button class="main" data-action="toggle"><ha-icon icon="${playing?"mdi:pause":"mdi:play"}"></ha-icon></button><button class="skip" data-action="next"><ha-icon icon="mdi:skip-next"></ha-icon></button><button class="${a.repeat&&a.repeat!=="off"?"activecmd":""}" data-action="repeat"><ha-icon icon="${a.repeat==="one"?"mdi:repeat-once":"mdi:repeat"}"></ha-icon></button></div>
    <div class="volume"><button data-action="mute"><ha-icon icon="${a.is_volume_muted?"mdi:volume-off":"mdi:volume-medium"}"></ha-icon></button><input id="vol" type="range" min="0" max="100" value="${volume}"><span>${volume}</span></div>
    <div class="group" data-view="rooms"><small>Playing in</small>${this._esc(rooms||"Select a room")} ›</div>`:
    this._view==="rooms"?`<div class="rooms"><div class="roomhead"><h1>Rooms</h1></div><div class="roomsummary">${this._players.length} Sonos rooms · ${this._groups().filter(g=>g.members.length>1).length} active group${this._groups().filter(g=>g.members.length>1).length===1?"":"s"}</div><div class="roomlist">${this._players.map(p=>{const pa=p.attributes||{},v=Math.round((pa.volume_level||0)*100),on=this._selectedRooms.has(p.entity_id),gm=pa.group_members||[p.entity_id],grouped=gm.length>1;return `<div class="room"><button class="check ${on?"on":""}" data-room="${p.entity_id}">${on?"✓":""}</button><div class="roommain"><div class="roomline"><div class="roomname">${this._esc(pa.friendly_name||p.entity_id)}</div><div class="roomstate">${grouped?`${gm.length} rooms`:(p.state==="playing"?"Playing":"")}</div></div><div class="roomsub">${this._esc(pa.media_title||(grouped?"Grouped":"Not playing"))}</div><div class="roomvol"><ha-icon icon="mdi:volume-medium"></ha-icon><input data-roomvol="${p.entity_id}" type="range" min="0" max="100" value="${v}"><span>${v}</span></div></div></div>`}).join("")}</div><div class="applybar"><button class="apply" id="apply" ${(!this._selectedRooms.size||this._sameMembers([...this._selectedRooms],this._currentGroup()))?"disabled":""}>${this._groupActionLabel()}</button></div></div>`:this._view==="music"?`<div class="music"><div class="roomhead"><h1>Music</h1></div><div class="musicdestlabel">Play in</div><button class="playerpick" id="playerpick"><span>${this._esc(this._playerChoices().find(p=>p.id===this._selected)?.label||a.friendly_name||"Select Sonos")}</span><ha-icon icon="mdi:chevron-down"></ha-icon></button><div class="picker ${this._pickerOpen?"open":""}" id="playerlist">${this._playerChoices().map(p=>`<button class="pickrow ${p.id===this._selected?"active":""}" data-select-player="${p.id}"><ha-icon icon="${p.icon}"></ha-icon><span><b>${this._esc(p.label)}</b><small>${this._esc(p.sub)}</small></span>${p.id===this._selected?`<ha-icon icon="mdi:check"></ha-icon>`:""}</button>`).join("")}</div><label class="search"><ha-icon icon="mdi:magnify"></ha-icon><input id="musicsearch" placeholder="Search Music Assistant" value="${this._esc(this._lastSearch||"")}"></label>${this._backendInfo?.music_assistant?.available?`<div id="maresults">${this._maResultsHtml()}</div>`:""}${this._backendInfo?.music_assistant?.available?`<div id="recent">${this._recentHtml()}</div>`:""}<div class="sectiontitle">Sonos Favorites</div><div id="favorites">${this._favoritesHtml()}</div></div>`:this._view==="queue"?`<div class="queue"><div class="queuehead"><div class="roomhead"><h1>Queue</h1></div>${(this._queue?.items||[]).length?`<button class="clearq" id="clearqueue">Clear Queue</button>`:""}</div><div class="musicdestlabel">Queue for</div><button class="playerpick" id="playerpick"><span>${this._esc(this._playerChoices().find(p=>p.id===this._selected)?.label||a.friendly_name||"Select Sonos")}</span><ha-icon icon="mdi:chevron-down"></ha-icon></button><div class="picker ${this._pickerOpen?"open":""}" id="playerlist">${this._playerChoices().map(p=>`<button class="pickrow ${p.id===this._selected?"active":""}" data-select-player="${p.id}"><ha-icon icon="${p.icon}"></ha-icon><span><b>${this._esc(p.label)}</b><small>${this._esc(p.sub)}</small></span>${p.id===this._selected?`<ha-icon icon="mdi:check"></ha-icon>`:""}</button>`).join("")}</div><div id="queueitems">${this._queueHtml()}</div></div>`:`<div class="stub"><h2>${this._view[0].toUpperCase()+this._view.slice(1)}</h2><div class="artist">Coming in the next implementation stage</div></div>`}
    </main><nav class="tabs">${this._tab("now","mdi:music-circle","Now Playing")}${this._tab("rooms","mdi:speaker-multiple","Rooms")}${this._tab("music","mdi:music-note","Music")}${this._tab("queue","mdi:playlist-music","Queue")}</nav></ha-card>`;
    const mainScroll=this.shadowRoot.querySelector(".viewscroll");
    if(mainScroll) mainScroll.scrollTop=this._scrollTop[this._view]||0;
    if(mainScroll && this._view==="music") mainScroll.addEventListener("scroll",()=>{if(this._maMenu!==null){this._maMenu=null;this.shadowRoot.querySelector(".maactionmenu")?.remove();}},{passive:true});
    const pickerScroll=this.shadowRoot.querySelector("#playerlist");
    if(pickerScroll) pickerScroll.scrollTop=this._pickerScrollTop[this._view]||0;
    this.shadowRoot.querySelectorAll("[data-view]").forEach(el=>el.onclick=()=>{this._view=el.dataset.view;this._render();if(this._view==="queue")this._loadQueue();});
    this.shadowRoot.querySelector("#playerpick")?.addEventListener("click",()=>{this._pickerOpen=!this._pickerOpen;this._render();});
    this.shadowRoot.querySelector("#playerlist")?.addEventListener("scroll",e=>{this._pickerScrollTop[this._view]=e.currentTarget.scrollTop;},{passive:true});
    this.shadowRoot.querySelectorAll("[data-select-player]").forEach(el=>el.onclick=()=>{this._selected=el.dataset.selectPlayer;this._pickerOpen=false;this._pickerScrollTop[this._view]=0;if(this._view==="queue"){this._queue=null;this._queuePlayer=null;}const g=this._groups().find(x=>x.members.includes(this._selected));this._selectedRooms=new Set(g?.members||[this._selected]);this._render();if(this._view==="queue")this._loadQueue(true);});
    this.shadowRoot.querySelector('[data-action="toggle"]')?.addEventListener("click",()=>this._call("media_play_pause"));
    this.shadowRoot.querySelector('[data-action="previous"]')?.addEventListener("click",()=>this._call("media_previous_track"));
    this.shadowRoot.querySelector('[data-action="next"]')?.addEventListener("click",()=>this._call("media_next_track"));
    this.shadowRoot.querySelector('[data-action="shuffle"]')?.addEventListener("click",()=>this._call("shuffle_set",{shuffle:!a.shuffle}));
    this.shadowRoot.querySelector('[data-action="repeat"]')?.addEventListener("click",()=>{const next=a.repeat==="off"?"all":a.repeat==="all"?"one":"off";this._call("repeat_set",{repeat:next});});
    this.shadowRoot.querySelector('[data-action="mute"]')?.addEventListener("click",()=>this._call("volume_mute",{is_volume_muted:!a.is_volume_muted}));
    const nowVol=this.shadowRoot.querySelector("#vol");
    nowVol?.addEventListener("input",e=>{const n=e.target.nextElementSibling;if(n)n.textContent=e.target.value;});
    nowVol?.addEventListener("change",e=>this._call("volume_set",{volume_level:Number(e.target.value)/100}));
    this.shadowRoot.querySelector("#seek")?.addEventListener("change",e=>{if(duration>0)this._call("media_seek",{seek_position:(Number(e.target.value)/100)*duration});});
    clearInterval(this._progressTimer);
    this._progressTimer=null;
    if(this._view==="now" && playing && duration>0){
      let livePosition=position;
      this._progressTimer=setInterval(()=>{
        livePosition=Math.min(duration,livePosition+1);
        const seek=this.shadowRoot?.querySelector("#seek");
        const elapsed=this.shadowRoot?.querySelector("#elapsed");
        if(seek) seek.value=String(Math.max(0,Math.min(100,(livePosition/duration)*100)));
        if(elapsed) elapsed.textContent=fmt(livePosition);
        if(livePosition>=duration){clearInterval(this._progressTimer);this._progressTimer=null;}
      },1000);
    }
    this.shadowRoot.querySelectorAll("[data-roomvol]").forEach(el=>{
      el.addEventListener("input",e=>{const n=e.target.nextElementSibling;if(n)n.textContent=e.target.value;clearTimeout(this._volumeSendTimer);const id=e.target.dataset.roomvol,v=Number(e.target.value)/100;this._volumeSendTimer=setTimeout(()=>this._hass.callService("media_player","volume_set",{entity_id:id,volume_level:v}),120);});
      el.addEventListener("change",e=>{clearTimeout(this._volumeSendTimer);this._hass.callService("media_player","volume_set",{entity_id:e.target.dataset.roomvol,volume_level:Number(e.target.value)/100});});
    });
    this.shadowRoot.querySelectorAll("[data-room]").forEach(el=>el.onclick=()=>{const id=el.dataset.room;this._selectedRooms.has(id)?this._selectedRooms.delete(id):this._selectedRooms.add(id);const on=this._selectedRooms.has(id);el.classList.toggle("on",on);el.textContent=on?"✓":"";const apply=this.shadowRoot.querySelector("#apply");if(apply){const same=!this._selectedRooms.size||this._sameMembers([...this._selectedRooms],this._currentGroup());apply.disabled=same;apply.textContent=this._groupActionLabel();}});
    this.shadowRoot.querySelectorAll("[data-ma-options]").forEach(el=>el.onclick=e=>{e.stopPropagation();this._maMenu=this._maMenu===el.dataset.maOptions?null:el.dataset.maOptions;this._render();});
    this.shadowRoot.querySelectorAll("[data-ma-action]").forEach(el=>el.onclick=async e=>{e.stopPropagation();const action=el.dataset.maAction;try{await this._hass.callWS({type:"sonos_remote/play",sonos_entity_id:this._selected,media_id:el.dataset.maUri,media_type:el.dataset.maType,enqueue:action==="play"?"replace":action});this._maMenu=null;this._queue=null;this._queuePlayer=null;if(action==="play"){this._view="now";this._render();}else{this._render();}}catch(err){this.dispatchEvent(new CustomEvent("hass-notification",{detail:{message:err?.message||"Unable to update queue"},bubbles:true,composed:true}));}});
    this.shadowRoot.querySelectorAll("[data-recent-uri]").forEach(el=>el.onclick=async()=>{try{await this._hass.callWS({type:"sonos_remote/play",sonos_entity_id:this._selected,media_id:el.dataset.recentUri,media_type:el.dataset.recentType,enqueue:"replace"});this._view="now";this._render();}catch(e){this.dispatchEvent(new CustomEvent("hass-notification",{detail:{message:e?.message||"Unable to play this recently played item"},bubbles:true,composed:true}));}});
    this.shadowRoot.querySelectorAll("[data-favorite]").forEach(el=>el.onclick=async()=>{try{await this._hass.callService("media_player","play_media",{entity_id:this._selected,media_content_type:"favorite_item_id",media_content_id:el.dataset.favorite});this._view="now";this._render();}catch(e){this.dispatchEvent(new CustomEvent("hass-notification",{detail:{message:e?.message||"Unable to play this Sonos Favorite"},bubbles:true,composed:true}));}});
    const musicSearch=this.shadowRoot.querySelector("#musicsearch");
    musicSearch?.addEventListener("input",e=>{this._lastSearch=e.target.value;});
    musicSearch?.addEventListener("keydown",e=>{
      if(e.key==="Enter"){
        e.preventDefault();
        e.stopPropagation();
        this._searchMA(e.target.value);
      }
    });
    this.shadowRoot.querySelectorAll("[data-ma-seeall]").forEach(el=>el.onclick=()=>this._searchMA(this._lastSearch,el.dataset.maSeeall));
    this.shadowRoot.querySelector("[data-ma-back]")?.addEventListener("click",()=>this._searchMA(this._lastSearch,null));
    this.shadowRoot.querySelectorAll("[data-ma-uri]").forEach(el=>el.onclick=async()=>{
      try{
        await this._hass.callWS({
          type:"sonos_remote/play",
          sonos_entity_id:this._selected,
          media_id:el.dataset.maUri,
          media_type:el.dataset.maType,
          enqueue:"replace"
        });
        this._view="now";
        this._render();
      }catch(e){
        this.dispatchEvent(new CustomEvent("hass-notification",{detail:{message:e?.message||"Unable to play this Music Assistant item"},bubbles:true,composed:true}));
      }
    });
    this.shadowRoot.querySelector("#openmedia")?.addEventListener("click",()=>{this._hass.navigate?.("/media-browser/browser");});
    this.shadowRoot.querySelectorAll("[data-qplay]").forEach(el=>el.onclick=()=>this._queueAction("play",el.dataset.qplay||null,Number(el.dataset.qindex)));
    this.shadowRoot.querySelectorAll("[data-qremove]").forEach(el=>el.onclick=e=>{e.stopPropagation();this._queueAction("remove",el.dataset.qremove||null,Number(el.dataset.qindex));});
    this.shadowRoot.querySelector("#clearqueue")?.addEventListener("click",()=>this._queueAction("clear"));
    this.shadowRoot.querySelector("#apply")?.addEventListener("click",async()=>{
      const chosen=[...this._selectedRooms];
      if(!chosen.length)return;
      const before=this._currentGroup();
      if(this._sameMembers(chosen,before))return;
      const leader=chosen.includes(this._selected)?this._selected:chosen[0];
      try{
        // Detach members that are being removed from the current group.
        for(const id of before){
          if(id!==leader && !chosen.includes(id))
            await this._hass.callService("media_player","unjoin",{entity_id:id});
        }
        // Detach rooms selected from other existing groups before joining this one.
        for(const id of chosen){
          if(id===leader)continue;
          const other=this._groups().find(g=>g.members.includes(id) && !g.members.includes(leader));
          if(other?.members?.length>1)
            await this._hass.callService("media_player","unjoin",{entity_id:id});
        }
        // If only the leader remains selected, separate it from any remaining group.
        if(chosen.length===1 && before.length>1)
          await this._hass.callService("media_player","unjoin",{entity_id:leader});
        else {
          const others=chosen.filter(id=>id!==leader);
          if(others.length)
            await this._hass.callService("media_player","join",{entity_id:leader,group_members:others});
        }
        this._selected=leader;
        this._selectedRooms=new Set(chosen);
        this._backendInfo=null;
        await this._loadBackendInfo();
      }catch(e){
        this.dispatchEvent(new CustomEvent("hass-notification",{detail:{message:e?.message||"Unable to update Sonos group"},bubbles:true,composed:true}));
      }
    });
  }
}
if(!customElements.get("sonos-remote-card")) customElements.define("sonos-remote-card",SonosRemoteCard);
window.customCards=window.customCards||[];
window.customCards.push({type:"sonos-remote-card",name:"Sonos Remote",description:"Mobile-first Sonos remote for Home Assistant."});
console.info("%c SONOS REMOTE %c v0.3.0 ","color:white;background:#03a9f4;font-weight:bold","color:#03a9f4;background:white");
