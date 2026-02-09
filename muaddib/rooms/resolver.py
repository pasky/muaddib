"""Command resolution helpers for room command handling."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from .message import RoomMessage

logger = logging.getLogger(__name__)


@dataclass
class ParsedPrefix:
    """Result of parsing command prefix from message."""

    no_context: bool
    mode_token: str | None
    model_override: str | None
    query_text: str
    error: str | None = None


@dataclass
class ResolvedCommand:
    """Result of resolving command text + channel policy into runtime settings."""

    no_context: bool
    query_text: str
    model_override: str | None
    selected_label: str | None
    selected_trigger: str | None
    mode_key: str | None
    runtime: dict[str, Any] | None
    error: str | None = None
    help_requested: bool = False
    channel_mode: str | None = None
    selected_automatically: bool = False


class CommandResolver:
    """Owns command parsing + policy resolution from room command config."""

    def __init__(
        self,
        command_config: dict[str, Any],
        *,
        classify_mode: Callable[[list[dict[str, str]]], Awaitable[str]],
        help_token: str,
        flag_tokens: set[str],
        model_name_formatter: Callable[[Any], str],
    ) -> None:
        self.command_config = command_config
        self._classify_mode = classify_mode
        self.help_token = help_token
        self.flag_tokens = set(flag_tokens)
        self._model_name_formatter = model_name_formatter

        self.trigger_to_mode: dict[str, str] = {}
        self.trigger_overrides: dict[str, dict[str, Any]] = {}
        self.default_trigger_by_mode: dict[str, str] = {}

        for mode_key, mode_cfg in self.command_config.get("modes", {}).items():
            triggers = mode_cfg.get("triggers", {})
            if not triggers:
                raise ValueError(f"Mode '{mode_key}' must define at least one trigger")
            self.default_trigger_by_mode[mode_key] = next(iter(triggers))
            for trigger, overrides in triggers.items():
                if trigger in self.trigger_to_mode:
                    raise ValueError(f"Duplicate trigger '{trigger}' in command mode config")
                if not isinstance(trigger, str) or not trigger.startswith("!"):
                    raise ValueError(f"Invalid trigger '{trigger}' for mode '{mode_key}'")
                self.trigger_to_mode[trigger] = mode_key
                self.trigger_overrides[trigger] = overrides or {}

        labels = self.command_config.get("mode_classifier", {}).get("labels", {})
        if not labels:
            raise ValueError("command.mode_classifier.labels must not be empty")
        for label, trigger in labels.items():
            if trigger not in self.trigger_to_mode:
                raise ValueError(
                    f"Classifier label '{label}' points to unknown trigger '{trigger}'"
                )
        self.classifier_label_to_trigger = labels
        self.fallback_classifier_label = self.command_config.get("mode_classifier", {}).get(
            "fallback_label"
        ) or next(iter(labels))
        if self.fallback_classifier_label not in labels:
            raise ValueError(
                f"Classifier fallback label '{self.fallback_classifier_label}' is not defined"
            )

    def parse_prefix(self, message: str) -> ParsedPrefix:
        """Parse leading modifier tokens from message."""
        text = message.strip()
        if not text:
            return ParsedPrefix(False, None, None, "", None)

        tokens = text.split()
        no_context = False
        mode_token: str | None = None
        model_override: str | None = None
        error: str | None = None
        consumed = 0

        for i, tok in enumerate(tokens):
            if tok in self.flag_tokens:
                no_context = True
                consumed = i + 1
                continue

            if tok in self.trigger_to_mode or tok == self.help_token:
                if mode_token is not None:
                    error = "Only one mode command allowed."
                    break
                mode_token = tok
                consumed = i + 1
                continue

            if tok.startswith("@") and len(tok) > 1:
                if model_override is None:
                    model_override = tok[1:]
                consumed = i + 1
                continue

            if tok.startswith("!"):
                error = f"Unknown command '{tok}'. Use {self.help_token} for help."
                break

            break

        query_text = " ".join(tokens[consumed:]) if consumed > 0 else text
        return ParsedPrefix(
            no_context=no_context,
            mode_token=mode_token,
            model_override=model_override,
            query_text=query_text,
            error=error,
        )

    def runtime_for_trigger(self, trigger: str) -> tuple[str, dict[str, Any]]:
        mode_key = self.trigger_to_mode.get(trigger)
        if mode_key is None:
            raise ValueError(f"Unknown trigger '{trigger}'")

        mode_cfg = self.command_config["modes"][mode_key]
        overrides = self.trigger_overrides[trigger]
        runtime = {
            "reasoning_effort": overrides.get(
                "reasoning_effort", mode_cfg.get("reasoning_effort", "minimal")
            ),
            "allowed_tools": overrides.get("allowed_tools", mode_cfg.get("allowed_tools")),
            "steering": overrides.get("steering", mode_cfg.get("steering", True)),
            "model": overrides.get("model"),
            "history_size": int(mode_cfg.get("history_size", self.command_config["history_size"])),
        }
        return mode_key, runtime

    def trigger_for_label(self, label: str) -> str:
        trigger = self.classifier_label_to_trigger.get(label)
        if trigger is None:
            logger.warning(
                "Unknown classifier label '%s', using fallback '%s'",
                label,
                self.fallback_classifier_label,
            )
            return self.classifier_label_to_trigger[self.fallback_classifier_label]
        return trigger

    @staticmethod
    def normalize_server_tag(server_tag: str) -> str:
        if server_tag.startswith("discord:"):
            return server_tag.split("discord:", 1)[1]
        if server_tag.startswith("slack:"):
            return server_tag.split("slack:", 1)[1]
        return server_tag

    @classmethod
    def channel_key(cls, server_tag: str, channel_name: str) -> str:
        normalized_server = cls.normalize_server_tag(server_tag)
        return f"{normalized_server}#{channel_name}"

    def get_channel_mode(self, server_tag: str, channel_name: str) -> str:
        channel_modes = self.command_config.get("channel_modes", {})
        channel_key = self.channel_key(server_tag, channel_name)
        if channel_key in channel_modes:
            return channel_modes[channel_key]
        return self.command_config.get("default_mode", "classifier")

    def should_bypass_steering_queue(self, msg: RoomMessage) -> bool:
        """Return True for commands that should not use steering queueing."""
        parsed = self.parse_prefix(msg.content)
        if parsed.error or parsed.no_context:
            return True
        if parsed.mode_token == self.help_token:
            return True
        if parsed.mode_token is not None:
            _, runtime = self.runtime_for_trigger(parsed.mode_token)
            return not bool(runtime["steering"])

        channel_mode = self.get_channel_mode(msg.server_tag, msg.channel_name)
        trigger = channel_mode
        if trigger not in self.trigger_to_mode and trigger in self.command_config["modes"]:
            trigger = self.default_trigger_by_mode[trigger]
        if trigger in self.trigger_to_mode:
            _, runtime = self.runtime_for_trigger(trigger)
            return not bool(runtime["steering"])
        return False

    def build_help_message(self, server_tag: str, channel_name: str) -> str:
        """Build command help text for current channel policy."""
        modes_config = self.command_config["modes"]
        classifier_model = self.command_config["mode_classifier"]["model"]
        channel_mode = self.get_channel_mode(server_tag, channel_name)
        if channel_mode == "classifier":
            default_desc = f"automatic mode ({classifier_model} decides)"
        elif channel_mode.startswith("classifier:"):
            default_desc = f"automatic mode constrained to {channel_mode.split(':', 1)[1]}"
        elif channel_mode in self.trigger_to_mode:
            default_desc = f"forced trigger {channel_mode} ({self.trigger_to_mode[channel_mode]})"
        else:
            default_desc = f"{channel_mode} mode"

        mode_parts: list[str] = []
        for mode_key, mode_cfg in modes_config.items():
            trigger_list = list(mode_cfg.get("triggers", {}).keys())
            if not trigger_list:
                continue
            model_value = mode_cfg.get("model")
            if isinstance(model_value, list):
                model_value = model_value[0] if model_value else ""
            model_desc = self._model_name_formatter(model_value) if model_value else ""
            mode_parts.append(f"{'/'.join(trigger_list)} = {mode_key} ({model_desc})")

        return (
            f"default is {default_desc}; modes: {', '.join(mode_parts)}; "
            "use @modelid to override model; !c disables context"
        )

    async def resolve(
        self,
        *,
        msg: RoomMessage,
        context: list[dict[str, str]],
        default_size: int,
    ) -> ResolvedCommand:
        """Resolve command mode/runtime from a message and channel policy."""

        parsed = self.parse_prefix(msg.content)
        if parsed.error:
            return ResolvedCommand(
                no_context=parsed.no_context,
                query_text=parsed.query_text,
                model_override=parsed.model_override,
                selected_label=None,
                selected_trigger=None,
                mode_key=None,
                runtime=None,
                error=parsed.error,
            )

        if parsed.mode_token == self.help_token:
            return ResolvedCommand(
                no_context=parsed.no_context,
                query_text=parsed.query_text,
                model_override=parsed.model_override,
                selected_label=None,
                selected_trigger=None,
                mode_key=None,
                runtime=None,
                help_requested=True,
            )

        no_context = parsed.no_context
        model_override = parsed.model_override
        query_text = parsed.query_text

        if parsed.mode_token:
            selected_trigger = parsed.mode_token
            mode_key, runtime = self.runtime_for_trigger(selected_trigger)
            selected_label = selected_trigger
            return ResolvedCommand(
                no_context=no_context,
                query_text=query_text,
                model_override=model_override,
                selected_label=selected_label,
                selected_trigger=selected_trigger,
                mode_key=mode_key,
                runtime=runtime,
                selected_automatically=False,
            )

        channel_mode = self.get_channel_mode(msg.server_tag, msg.channel_name)

        if channel_mode == "classifier":
            selected_label = await self._classify_mode(context)
            selected_trigger = self.trigger_for_label(selected_label)
        elif channel_mode.startswith("classifier:"):
            constrained_mode = channel_mode.split(":", 1)[1]
            if constrained_mode not in self.command_config["modes"]:
                return ResolvedCommand(
                    no_context=no_context,
                    query_text=query_text,
                    model_override=model_override,
                    selected_label=None,
                    selected_trigger=None,
                    mode_key=None,
                    runtime=None,
                    error=(
                        f"Unknown channel mode policy '{channel_mode}': "
                        f"mode '{constrained_mode}' missing"
                    ),
                    channel_mode=channel_mode,
                    selected_automatically=True,
                )
            selected_label = await self._classify_mode(context[-default_size:])
            selected_trigger = self.trigger_for_label(selected_label)
            selected_mode_key, _ = self.runtime_for_trigger(selected_trigger)
            if selected_mode_key != constrained_mode:
                selected_trigger = self.default_trigger_by_mode[constrained_mode]
                selected_label = selected_trigger
        elif channel_mode in self.trigger_to_mode:
            selected_trigger = channel_mode
            selected_label = selected_trigger
        elif channel_mode in self.command_config["modes"]:
            selected_trigger = self.default_trigger_by_mode[channel_mode]
            selected_label = selected_trigger
        else:
            return ResolvedCommand(
                no_context=no_context,
                query_text=query_text,
                model_override=model_override,
                selected_label=None,
                selected_trigger=None,
                mode_key=None,
                runtime=None,
                error=f"Unknown channel mode policy '{channel_mode}'",
                channel_mode=channel_mode,
                selected_automatically=True,
            )

        mode_key, runtime = self.runtime_for_trigger(selected_trigger)
        return ResolvedCommand(
            no_context=no_context,
            query_text=query_text,
            model_override=model_override,
            selected_label=selected_label,
            selected_trigger=selected_trigger,
            mode_key=mode_key,
            runtime=runtime,
            channel_mode=channel_mode,
            selected_automatically=True,
        )
