"""Explicit adapter registry. Not a plugin loader."""
from bumparr.generation.providers.minimax import MiniMaxAdapter
from bumparr.generation.providers.openrouter import OpenRouterAdapter

ADAPTERS = {
    "minimax": MiniMaxAdapter,
    "openrouter": OpenRouterAdapter,
}


def get_adapter(name, **kwargs):
    cls = ADAPTERS.get(name)
    if cls is None:
        raise KeyError("unknown generation provider")
    return cls(**kwargs)
