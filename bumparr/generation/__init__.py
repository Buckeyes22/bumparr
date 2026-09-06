"""Durable, provider-neutral generation core.

Adapters speak MiniMax or OpenRouter protocol. Selection, station, and
playlist code stay provider-agnostic. Generation is off unless
GENERATION_ENABLED is the exact string ``1``.
"""
