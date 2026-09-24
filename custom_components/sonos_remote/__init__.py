from __future__ import annotations

from pathlib import Path

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er

from .const import CARD_URL, DOMAIN, VERSION


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    frontend_path = Path(__file__).parent / "www" / "sonos-remote-card.js"
    domain_data = hass.data.setdefault(DOMAIN, {})

    if not domain_data.get("static_registered"):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(CARD_URL, str(frontend_path), False)]
        )
        domain_data["static_registered"] = True

    if not domain_data.get("ws_registered"):
        websocket_api.async_register_command(hass, websocket_sonos_remote_info)
        websocket_api.async_register_command(hass, websocket_sonos_remote_search)
        websocket_api.async_register_command(hass, websocket_sonos_remote_play)
        websocket_api.async_register_command(hass, websocket_sonos_remote_recently_played)
        websocket_api.async_register_command(hass, websocket_sonos_remote_queue)
        websocket_api.async_register_command(hass, websocket_sonos_remote_queue_action)
        domain_data["ws_registered"] = True

    frontend = hass.data.get("frontend")
    if frontend is not None:
        extra_modules = getattr(frontend, "extra_modules", None)
        if extra_modules is not None:
            extra_modules.add(f"{CARD_URL}?v={VERSION}")

    domain_data[entry.entry_id] = {}
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    return True


def _platform_entities(hass: HomeAssistant, platform: str) -> list[str]:
    registry = er.async_get(hass)
    return sorted(
        entity.entity_id
        for entity in registry.entities.values()
        if entity.platform == platform and entity.domain == "media_player"
    )


def _sonos_entities(hass: HomeAssistant) -> list[str]:
    return _platform_entities(hass, "sonos")


def _ma_entry(hass: HomeAssistant):
    entries = hass.config_entries.async_entries("music_assistant")
    return entries[0] if entries else None


def _ma_players(hass: HomeAssistant) -> list[dict]:
    players = []
    for entity_id in _platform_entities(hass, "music_assistant"):
        state = hass.states.get(entity_id)
        if state is None:
            continue
        players.append(
            {
                "entity_id": entity_id,
                "name": state.attributes.get("friendly_name", entity_id),
                "state": state.state,
            }
        )
    return players


def _ma_player_for_sonos(hass: HomeAssistant, sonos_entity_id: str) -> str | None:
    sonos = hass.states.get(sonos_entity_id)
    if sonos is None:
        return None
    sonos_name = str(sonos.attributes.get("friendly_name", "")).strip().casefold()
    if not sonos_name:
        return None

    exact = []
    contains = []
    for player in _ma_players(hass):
        ma_name = str(player["name"]).strip().casefold()
        if ma_name == sonos_name:
            exact.append(player["entity_id"])
        elif sonos_name in ma_name or ma_name in sonos_name:
            contains.append(player["entity_id"])
    if len(exact) == 1:
        return exact[0]
    if len(contains) == 1:
        return contains[0]
    return None


def _ma_client(hass: HomeAssistant):
    entry = _ma_entry(hass)
    runtime = getattr(entry, "runtime_data", None) if entry else None
    return getattr(runtime, "mass", None)


def _ma_player_id(hass: HomeAssistant, ma_entity_id: str) -> str | None:
    registry = er.async_get(hass)
    entity = registry.async_get(ma_entity_id)
    if entity is None:
        return None
    unique_id = str(entity.unique_id)
    return unique_id.split("mass_", 1)[1] if "mass_" in unique_id else unique_id


async def _queue_context(hass: HomeAssistant, sonos_entity_id: str):
    ma_entity = _ma_player_for_sonos(hass, sonos_entity_id)
    mass = _ma_client(hass)
    if ma_entity is None or mass is None:
        return None, None, None
    player_id = _ma_player_id(hass, ma_entity)
    if not player_id:
        return ma_entity, None, None
    queue = await mass.player_queues.get_active_queue(player_id)
    return ma_entity, mass, queue


@websocket_api.websocket_command(
    {
        "type": "sonos_remote/recently_played",
        vol.Optional("limit", default=10): vol.All(int, vol.Range(min=1, max=50)),
    }
)
@websocket_api.async_response
async def websocket_sonos_remote_recently_played(hass, connection, msg):
    mass = _ma_client(hass)
    if mass is None:
        connection.send_result(msg["id"], {"available": False, "items": []})
        return
    try:
        items = await mass.music.recently_played(limit=msg["limit"], fully_played_only=False)
        connection.send_result(
            msg["id"],
            {
                "available": True,
                "items": [item.to_dict() for item in items],
            },
        )
    except Exception as err:  # MA API compatibility: fail quietly in optional feature
        connection.send_result(msg["id"], {"available": False, "items": [], "error": str(err)})


@websocket_api.websocket_command({"type": "sonos_remote/info"})
@websocket_api.async_response
async def websocket_sonos_remote_info(hass, connection, msg):
    players = []
    for entity_id in _sonos_entities(hass):
        state = hass.states.get(entity_id)
        if state is None:
            continue
        attrs = state.attributes
        players.append(
            {
                "entity_id": entity_id,
                "name": attrs.get("friendly_name", entity_id),
                "state": state.state,
                "group_members": attrs.get("group_members", [entity_id]),
                "volume_level": attrs.get("volume_level"),
                "music_assistant_player": _ma_player_for_sonos(hass, entity_id),
            }
        )

    ma_entry = _ma_entry(hass)
    connection.send_result(
        msg["id"],
        {
            "version": VERSION,
            "players": players,
            "music_assistant": {
                "available": ma_entry is not None
                and hass.services.has_service("music_assistant", "search"),
                "config_entry_id": ma_entry.entry_id if ma_entry else None,
                "players": _ma_players(hass),
            },
        },
    )


@websocket_api.websocket_command(
    {
        "type": "sonos_remote/search",
        vol.Required("query"): str,
        vol.Optional("limit", default=5): vol.All(int, vol.Range(min=1, max=50)),
        vol.Optional("media_type"): vol.In(["artist", "album", "track", "playlist", "radio"]),
    }
)
@websocket_api.async_response
async def websocket_sonos_remote_search(hass, connection, msg):
    ma_entry = _ma_entry(hass)
    if ma_entry is None or not hass.services.has_service("music_assistant", "search"):
        connection.send_error(msg["id"], "music_assistant_unavailable", "Music Assistant integration is not available")
        return

    response = await hass.services.async_call(
        "music_assistant",
        "search",
        {
            "config_entry_id": ma_entry.entry_id,
            "name": msg["query"],
            "media_type": [msg["media_type"]] if msg.get("media_type") else ["artist", "album", "track", "playlist", "radio"],
            "limit": msg["limit"],
            "library_only": False,
        },
        blocking=True,
        return_response=True,
    )
    connection.send_result(msg["id"], response or {})


@websocket_api.websocket_command(
    {
        "type": "sonos_remote/play",
        vol.Required("sonos_entity_id"): str,
        vol.Required("media_id"): str,
        vol.Optional("media_type"): str,
        vol.Optional("enqueue", default="replace"): vol.In(
            ["play", "replace", "next", "replace_next", "add"]
        ),
    }
)
@websocket_api.async_response
async def websocket_sonos_remote_play(hass, connection, msg):
    ma_player = _ma_player_for_sonos(hass, msg["sonos_entity_id"])
    if ma_player is None:
        connection.send_error(
            msg["id"],
            "music_assistant_player_not_found",
            "No unique Music Assistant player matches the selected Sonos room",
        )
        return

    data = {
        "media_id": msg["media_id"],
        "enqueue": msg["enqueue"],
    }
    if msg.get("media_type"):
        data["media_type"] = msg["media_type"]

    await hass.services.async_call(
        "music_assistant",
        "play_media",
        data,
        target={"entity_id": ma_player},
        blocking=True,
    )
    connection.send_result(msg["id"], {"player": ma_player})


@websocket_api.websocket_command(
    {
        "type": "sonos_remote/queue",
        vol.Required("sonos_entity_id"): str,
        vol.Optional("limit", default=100): vol.All(int, vol.Range(min=1, max=500)),
    }
)
@websocket_api.async_response
async def websocket_sonos_remote_queue(hass, connection, msg):
    ma_entity, mass, queue = await _queue_context(hass, msg["sonos_entity_id"])
    if ma_entity is not None and mass is not None:
        if queue is None:
            connection.send_result(msg["id"], {"available": True, "source": "music_assistant", "items": [], "current_index": None})
            return
        items = await mass.player_queues.get_queue_items(queue.queue_id, limit=msg["limit"])
        connection.send_result(
            msg["id"],
            {
                "available": True,
                "source": "music_assistant",
                "queue_id": queue.queue_id,
                "current_index": queue.current_index,
                "items": [item.to_dict() for item in items],
            },
        )
        return

    # Native Sonos fallback. Home Assistant's Sonos integration exposes its
    # local queue even when Music Assistant is not installed.
    if not hass.services.has_service("sonos", "get_queue"):
        connection.send_error(msg["id"], "queue_unavailable", "Queue management is not available")
        return
    response = await hass.services.async_call(
        "sonos",
        "get_queue",
        {},
        target={"entity_id": msg["sonos_entity_id"]},
        blocking=True,
        return_response=True,
    )
    items = list((response or {}).get(msg["sonos_entity_id"], []))[: msg["limit"]]
    state = hass.states.get(msg["sonos_entity_id"])
    current_id = state.attributes.get("media_content_id") if state else None
    current_index = next(
        (idx for idx, item in enumerate(items) if current_id and item.get("media_content_id") == current_id),
        None,
    )
    connection.send_result(
        msg["id"],
        {"available": True, "source": "sonos", "items": items, "current_index": current_index},
    )


@websocket_api.websocket_command(
    {
        "type": "sonos_remote/queue_action",
        vol.Required("sonos_entity_id"): str,
        vol.Required("action"): vol.In(["play", "remove", "clear"]),
        vol.Optional("item_id"): str,
        vol.Optional("index"): int,
    }
)
@websocket_api.async_response
async def websocket_sonos_remote_queue_action(hass, connection, msg):
    ma_entity, mass, queue = await _queue_context(hass, msg["sonos_entity_id"])
    action = msg["action"]
    if ma_entity is not None and mass is not None and queue is not None:
        if action == "clear":
            await mass.player_queues.clear(queue.queue_id)
        elif action == "play":
            target = msg.get("item_id") if msg.get("item_id") is not None else msg.get("index")
            if target is None:
                connection.send_error(msg["id"], "queue_item_required", "Queue item is required")
                return
            await mass.player_queues.play_index(queue.queue_id, target)
        elif action == "remove":
            target = msg.get("item_id") if msg.get("item_id") is not None else msg.get("index")
            if target is None:
                connection.send_error(msg["id"], "queue_item_required", "Queue item is required")
                return
            await mass.player_queues.delete_item(queue.queue_id, target)
        connection.send_result(msg["id"], {"ok": True, "source": "music_assistant"})
        return

    # Native Sonos queue actions use zero-based queue positions.
    index = msg.get("index")
    if action in ("play", "remove") and index is None:
        connection.send_error(msg["id"], "queue_item_required", "Queue position is required")
        return
    if action == "play":
        await hass.services.async_call(
            "sonos", "play_queue", {"queue_position": index},
            target={"entity_id": msg["sonos_entity_id"]}, blocking=True,
        )
    elif action == "remove":
        await hass.services.async_call(
            "sonos", "remove_from_queue", {"queue_position": index},
            target={"entity_id": msg["sonos_entity_id"]}, blocking=True,
        )
    elif action == "clear":
        response = await hass.services.async_call(
            "sonos", "get_queue", {},
            target={"entity_id": msg["sonos_entity_id"]}, blocking=True, return_response=True,
        )
        items = list((response or {}).get(msg["sonos_entity_id"], []))
        for queue_position in range(len(items) - 1, -1, -1):
            await hass.services.async_call(
                "sonos", "remove_from_queue", {"queue_position": queue_position},
                target={"entity_id": msg["sonos_entity_id"]}, blocking=True,
            )
    connection.send_result(msg["id"], {"ok": True, "source": "sonos"})
