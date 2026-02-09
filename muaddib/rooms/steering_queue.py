"""Steering queue state machine for command/passive room events."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TypeAlias

from .message import RoomMessage

SteeringKey: TypeAlias = tuple[str, str, str | None]


@dataclass
class QueuedInboundMessage:
    """Queued inbound message waiting for an active steering session runner."""

    kind: str  # "command" | "passive"
    msg: RoomMessage
    trigger_message_id: int | None
    reply_sender: Callable[[str], Awaitable[None]]
    completion: asyncio.Future[None]


@dataclass
class SteeringSession:
    """In-flight steering session for a specific steering key."""

    queue: list[QueuedInboundMessage]


class SteeringQueue:
    """Concurrency-safe queue manager for steering sessions."""

    def __init__(self) -> None:
        self._sessions: dict[SteeringKey, SteeringSession] = {}
        self._lock = asyncio.Lock()

    @staticmethod
    def key_for_message(msg: RoomMessage) -> SteeringKey:
        # Non-threaded steering stays scoped to same sender.
        # In thread, steering is shared by thread participants.
        if msg.thread_id is not None:
            return (msg.arc, "*", msg.thread_id)
        return (msg.arc, msg.nick.lower(), None)

    @staticmethod
    def steering_context_message(msg: RoomMessage) -> dict[str, str]:
        return {"role": "user", "content": f"<{msg.nick}> {msg.content}"}

    @staticmethod
    def finish_item(item: QueuedInboundMessage) -> None:
        if not item.completion.done():
            item.completion.set_result(None)

    @staticmethod
    def fail_item(item: QueuedInboundMessage, exc: BaseException) -> None:
        if not item.completion.done():
            item.completion.set_exception(exc)

    async def enqueue_command_or_start_runner(
        self,
        msg: RoomMessage,
        trigger_message_id: int,
        reply_sender: Callable[[str], Awaitable[None]],
    ) -> tuple[bool, SteeringKey, QueuedInboundMessage]:
        item = QueuedInboundMessage(
            kind="command",
            msg=msg,
            trigger_message_id=trigger_message_id,
            reply_sender=reply_sender,
            completion=asyncio.get_running_loop().create_future(),
        )
        key = self.key_for_message(msg)
        async with self._lock:
            session = self._sessions.get(key)
            if session is None:
                self._sessions[key] = SteeringSession(queue=[])
                return True, key, item
            session.queue.append(item)
            return False, key, item

    async def enqueue_passive_if_session_exists(
        self,
        msg: RoomMessage,
        reply_sender: Callable[[str], Awaitable[None]],
    ) -> QueuedInboundMessage | None:
        key = self.key_for_message(msg)
        async with self._lock:
            session = self._sessions.get(key)
            if session is None:
                return None
            queued_item = QueuedInboundMessage(
                kind="passive",
                msg=msg,
                trigger_message_id=None,
                reply_sender=reply_sender,
                completion=asyncio.get_running_loop().create_future(),
            )
            session.queue.append(queued_item)
            return queued_item

    async def drain_steering_context_messages(self, key: SteeringKey) -> list[dict[str, str]]:
        """Drain currently queued inbound items into steering context."""
        async with self._lock:
            session = self._sessions.get(key)
            if session is None or not session.queue:
                return []
            drained = list(session.queue)
            session.queue.clear()

        for item in drained:
            self.finish_item(item)

        return [self.steering_context_message(item.msg) for item in drained]

    async def take_next_work_compacted(
        self, key: SteeringKey
    ) -> tuple[list[QueuedInboundMessage], QueuedInboundMessage | None]:
        """Take next work item while compacting passive queue noise.

        Policy:
          - If a command exists in queue: drop all passives before first command.
          - If no command exists: keep only the last passive.

        When nothing remains, the session is removed (closed).

        Returns: (dropped_items, next_item_or_None)
        """
        async with self._lock:
            session = self._sessions.get(key)
            if session is None:
                return [], None

            if not session.queue:
                self._sessions.pop(key, None)
                return [], None

            queue = session.queue
            first_command_index = next(
                (i for i, item in enumerate(queue) if item.kind == "command"),
                None,
            )

            if first_command_index is not None:
                dropped = queue[:first_command_index]
                next_item = queue[first_command_index]
                session.queue = queue[first_command_index + 1 :]
                return dropped, next_item

            dropped = queue[:-1]
            next_item = queue[-1]
            session.queue = []
            return dropped, next_item

    async def abort_session(
        self, key: SteeringKey, exc: BaseException
    ) -> list[QueuedInboundMessage]:
        async with self._lock:
            session = self._sessions.pop(key, None)
            if session is None:
                return []
            remaining = list(session.queue)

        for item in remaining:
            self.fail_item(item, exc)
        return remaining
