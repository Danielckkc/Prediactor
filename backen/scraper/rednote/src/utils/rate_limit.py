import threading
import time
from typing import Callable, TypeVar, Any, cast

T = TypeVar("T")

class RateLimiter:
    """
    Simple token-bucket style rate limiter.
    Ensures that at most `calls_per_minute` are executed, with an optional burst.
    """

    def __init__(self, calls_per_minute: int = 60, burst: int = 5) -> None:
        self.calls_per_minute = max(1, calls_per_minute)
        self.interval = 60.0 / float(self.calls_per_minute)
        self.burst = max(1, burst)

        self._lock = threading.Lock()
        self._tokens = float(burst)
        self._last_refill = time.monotonic()

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_refill
        if elapsed <= 0:
            return
        new_tokens = elapsed * (self.calls_per_minute / 60.0)
        if new_tokens > 0:
            self._tokens = min(self.burst, self._tokens + new_tokens)
            self._last_refill = now

    def wait(self) -> None:
        """
        Blocks until a token is available, then consumes it.
        """
        with self._lock:
            while True:
                self._refill()
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return
                # Not enough tokens; sleep for a fraction of interval
                time.sleep(self.interval / 2.0)

def rate_limited(limiter: RateLimiter) -> Callable[[Callable[..., T]], Callable[..., T]]:
    """
    Decorator to apply rate limiting to arbitrary callables.

    Example:
        limiter = RateLimiter(calls_per_minute=30)
        @rate_limited(limiter)
        def fetch(...):
            ...
    """

    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        def wrapper(*args: Any, **kwargs: Any) -> T:
            limiter.wait()
            return func(*args, **kwargs)

        return cast(Callable[..., T], wrapper)

    return decorator
