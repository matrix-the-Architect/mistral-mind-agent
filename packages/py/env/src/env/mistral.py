from env._base import BaseEnv


class Env(BaseEnv):
    mistral_api_key: str | None = None
    # Optional Mistral REST API base URL. None uses the SDK default.
    mistral_base_url: str | None = None
    # The one model the relay will call; the browser can never choose another.
    mistral_model: str = "mistral-medium-latest"


env = Env()
