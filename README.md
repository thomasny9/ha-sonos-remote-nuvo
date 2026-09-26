# Sonos Remote with Nuvo

> Designed specifically for hybrid whole-home audio systems that combine Sonos with Nuvo multi-zone audio. Sonos provides the modern music and playback layer, while Nuvo zones remain fully usable as distributed room outputs.

Sonos Remote with Nuvo is a mobile-first Home Assistant remote with a Lovelace frontend and a companion backend integration.

## v0.7.4

This revision makes Nuvo rooms the primary listening targets in hybrid Sonos + Nuvo systems. The Now Playing selector includes individual Nuvo zones, active same-source multi-zone combinations, and the underlying Sonos sources. Nuvo selections control zone/group volume and source while Sonos remains the playback engine. Fixed-level Sonos sources no longer present a misleading Now Playing volume control.

### Backend
- Home Assistant custom integration at `custom_components/sonos_remote`
- UI config flow
- Depends on Home Assistant's native Sonos integration
- Serves the bundled Lovelace card locally
- Provides the first `sonos_remote/info` WebSocket endpoint for richer frontend/backend communication

### Frontend
- iPhone-first single-column layout
- Now Playing artwork and metadata
- Play/pause, previous and next
- Volume control
- Current group display
- Four standard internal views: Now Playing, Rooms, Music and Queue\n- A fifth **My Music** tab appears when Music Assistant is available, with cached provider browsing, Back/Home navigation, and Play Now / Play Next / Add to Queue\n- Now Playing → ⋮ → **Default Nuvo zone** lets you choose and persist which Nuvo listening zone opens by default
- Now Playing → ⋮ → **My Music services** controls which MA services appear at the My Music root\n- Sonos rows in Rooms show actual playback state separately from retained media titles (Playing, Paused, Idle, Off, Unavailable)\n- Nuvo zone rows resolve their selected Sonos source and show the same playback-state badge separately from the current/last media title
- Home Assistant theme support
- Rooms, Music and Queue are the next implementation stages

## Install with HACS

Add this repository as a custom HACS **Integration** repository and download it.

Restart Home Assistant, then go to **Settings → Devices & services → Add Integration → Sonos Remote with Nuvo**.

The integration serves the card at:

`/sonos_remote/sonos-remote-card.js`

Add the following URL once under **Settings → Dashboards → Resources** as a **JavaScript Module**:

`/sonos_remote/sonos-remote-card.js?v=0.7.4`

This explicit Lovelace resource is intentional. It avoids a Home Assistant cold-load race where automatically injected custom-card JavaScript can load after the dashboard tries to create the card, resulting in a temporary **Custom element doesn't exist** error after a hard refresh.

Then add the card:

```yaml
type: custom:sonos-remote-card
```

Optional explicit player configuration:

```yaml
type: custom:sonos-remote-card
entities:
  - media_player.living_room
  - media_player.kitchen
default_player: media_player.living_room
```

## Architecture

The native Home Assistant Sonos integration remains responsible for normal speaker control. Sonos Remote with Nuvo adds a purpose-built mobile UI and a lightweight backend for features that are awkward or unavailable through the generic `media_player` frontend API.

Planned backend-assisted features include room/group management, Sonos Favorites/media browsing, queue access and manipulation, capability discovery, and richer search where Home Assistant/Sonos expose it.
