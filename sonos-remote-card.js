class SonosRemoteCard extends HTMLElement {
  setConfig(config) {
    this.config = config || {};
    this._view = this._view || "now";
    this.attachShadow({ mode: "open" });
  }

  set hass(hass) {
    this._hass = hass;
    this._players = this._discoverPlayers(hass);
    this._selected = this._selected && hass.states[this._selected]
      ? this._selected
      : (this.config.default_player || this._players[0]?.entity_id);
    this._render();
  }

  getCardSize() { return 8; }

  _discoverPlayers(hass) {
    const configured = this.config.entities || [];
    if (configured.length) return configured.map(id => hass.states[id]).filter(Boolean);
    return Object.values(hass.states).filter(s =>
      s.entity_id.startsWith("media_player.") &&
      (s.attributes.platform === "sonos" ||
       s.attributes.integration === "sonos" ||
       Array.isArray(s.attributes.sonos_group) ||
       (s.attributes.device_class === "speaker" && "group_members" in s.attributes))
    );
  }

  _call(service, data = {}) {
    if (!this._hass || !this._selected) return;
    return this._hass.callService("media_player", service, { entity_id: this._selected, ...data });
  }

  _render() {
    if (!this.shadowRoot || !this._hass) return;
    const st = this._hass.states[this._selected];
    const a = st?.attributes || {};
    const title = a.media_title || "Nothing playing";
    const artist = a.media_artist || "";
    const album = a.media_album_name || "";
    const art = a.entity_picture ? this._hass.hassUrl(a.entity_picture) : "";
    const playing = st?.state === "playing";
    const volume = Math.round((a.volume_level || 0) * 100);
    const members = a.group_members || a.sonos_group || [this._selected].filter(Boolean);
    const roomNames = members.map(id => this._hass.states[id]?.attributes?.friendly_name || id).join(" + ");

    this.shadowRoot.innerHTML = `
      <style>
        :host { --sr-radius: 22px; display:block; }
        ha-card { overflow:hidden; border-radius:var(--sr-radius); background:var(--ha-card-background,var(--card-background-color)); color:var(--primary-text-color); }
        .wrap { padding:18px 18px 8px; }
        .art { aspect-ratio:1/1; width:100%; border-radius:18px; object-fit:cover; background:var(--secondary-background-color); display:block; }
        .placeholder { aspect-ratio:1/1; border-radius:18px; display:grid; place-items:center; background:var(--secondary-background-color); font-size:64px; opacity:.65; }
        h2 { margin:18px 0 3px; font-size:26px; line-height:1.1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .artist,.album { color:var(--secondary-text-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .album { font-size:13px; margin-top:3px; }
        .controls { display:grid; grid-template-columns:1fr 1fr 1fr; align-items:center; margin:18px 18px 12px; }
        button { appearance:none; border:0; background:none; color:inherit; min-height:48px; cursor:pointer; }
        .main { width:68px; height:68px; border:1px solid var(--divider-color); border-radius:50%; justify-self:center; font-size:27px; }
        .skip { font-size:25px; }
        .volume { display:grid; grid-template-columns:28px 1fr 38px; gap:8px; align-items:center; margin:0 18px 18px; }
        input[type=range] { width:100%; }
        .group { margin:0 18px 18px; padding:13px 14px; border-radius:14px; background:var(--secondary-background-color); cursor:pointer; }
        .group small { display:block; color:var(--secondary-text-color); margin-bottom:3px; }
        .tabs { display:grid; grid-template-columns:repeat(4,1fr); border-top:1px solid var(--divider-color); padding:7px 4px calc(7px + env(safe-area-inset-bottom)); }
        .tab { font-size:11px; opacity:.62; display:flex; flex-direction:column; gap:4px; align-items:center; }
        .tab.active { opacity:1; color:var(--primary-color); }
        .tab ha-icon { --mdc-icon-size:22px; }
        .stub { min-height:520px; padding:20px; }
        .stub h2 { margin-top:0; }
        @media (min-width:600px){ ha-card{max-width:430px;margin:auto;} }
      </style>
      <ha-card>
        ${this._view === "now" ? `
          <div class="wrap">
            ${art ? `<img class="art" src="${art}" alt="">` : `<div class="placeholder">♫</div>`}
            <h2>${this._esc(title)}</h2>
            <div class="artist">${this._esc(artist)}</div>
            <div class="album">${this._esc(album)}</div>
          </div>
          <div class="controls">
            <button class="skip" data-action="previous">◀︎</button>
            <button class="main" data-action="toggle">${playing ? "Ⅱ" : "▶"}</button>
            <button class="skip" data-action="next">▶︎</button>
          </div>
          <div class="volume"><ha-icon icon="mdi:volume-medium"></ha-icon><input id="vol" type="range" min="0" max="100" value="${volume}"><span>${volume}</span></div>
          <div class="group" data-view="rooms"><small>Playing in</small>${this._esc(roomNames || "Select a room")} ›</div>
        ` : `
          <div class="stub"><h2>${this._view[0].toUpperCase()+this._view.slice(1)}</h2><div class="artist">v0.1 shell — next implementation stage</div></div>
        `}
        <nav class="tabs">
          ${this._tab("now","mdi:music-circle","Now Playing")}
          ${this._tab("rooms","mdi:speaker-multiple","Rooms")}
          ${this._tab("music","mdi:music-note","Music")}
          ${this._tab("queue","mdi:playlist-music","Queue")}
        </nav>
      </ha-card>`;

    this.shadowRoot.querySelectorAll("[data-view]").forEach(el => el.onclick = () => { this._view=el.dataset.view; this._render(); });
    this.shadowRoot.querySelector('[data-action="toggle"]')?.addEventListener("click",()=>this._call("media_play_pause"));
    this.shadowRoot.querySelector('[data-action="previous"]')?.addEventListener("click",()=>this._call("media_previous_track"));
    this.shadowRoot.querySelector('[data-action="next"]')?.addEventListener("click",()=>this._call("media_next_track"));
    this.shadowRoot.querySelector("#vol")?.addEventListener("change",e=>this._call("volume_set",{volume_level:Number(e.target.value)/100}));
  }

  _tab(id, icon, label) {
    return `<button class="tab ${this._view===id?"active":""}" data-view="${id}"><ha-icon icon="${icon}"></ha-icon><span>${label}</span></button>`;
  }
  _esc(v) { const d=document.createElement("div"); d.textContent=v||""; return d.innerHTML; }
}
customElements.define("sonos-remote-card", SonosRemoteCard);
window.customCards = window.customCards || [];
window.customCards.push({ type:"sonos-remote-card", name:"Sonos Remote", description:"Mobile-first Sonos remote for Home Assistant." });
console.info("%c SONOS-REMOTE-CARD %c v0.1.0 ","color:white;background:#03a9f4;font-weight:bold","color:#03a9f4;background:white");
