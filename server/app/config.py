import json
from typing import Annotated, Any, Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    aws_region: str = "us-east-1"
    bedrock_model_id: str = "us.anthropic.claude-sonnet-5-5"
    simulator_provider: Literal["ollama", "bedrock"] = "ollama"
    simulator_ollama_model: str = "llama3.1:8b"
    ollama_host: str = "http://localhost:11434"
    dynamodb_table: str = "homie-dev"
    dynamodb_endpoint_url: str | None = None
    cors_origins: list[str] = ["http://localhost:3000"]
    cognito_user_pool_id: str = ""
    cognito_domain: str = ""
    cognito_client_ids: Annotated[list[str], NoDecode] = []
    public_base_url: str = "http://localhost:8000"
    mcp_tools_scope: str = "homie/mcp:tools"
    mcp_service_scope: str = "homie/mcp:service"
    media_bucket: str = ""
    google_maps_api_key: str = ""
    google_client_id: str = ""
    google_client_secret: str = ""

    @field_validator("simulator_provider", mode="before")
    @classmethod
    def default_empty_simulator_provider(cls, value: Any) -> Any:
        return value or "ollama"

    @field_validator("simulator_ollama_model", mode="before")
    @classmethod
    def default_empty_ollama_model(cls, value: Any) -> Any:
        return value or "llama3.1:8b"

    @field_validator("ollama_host", mode="before")
    @classmethod
    def default_empty_ollama_host(cls, value: Any) -> Any:
        return value or "http://localhost:11434"

    @field_validator("cognito_client_ids", mode="before")
    @classmethod
    def parse_cognito_client_ids(cls, value: Any) -> Any:
        if not isinstance(value, str):
            return value
        value = value.strip()
        if value.startswith("["):
            return json.loads(value)
        return [client_id.strip() for client_id in value.split(",") if client_id.strip()]

    @property
    def cognito_issuer(self) -> str:
        if not self.cognito_user_pool_id:
            return ""
        region = self.cognito_user_pool_id.split("_", maxsplit=1)[0] or self.aws_region
        return f"https://cognito-idp.{region}.amazonaws.com/{self.cognito_user_pool_id}"

    @property
    def cognito_jwks_url(self) -> str:
        issuer = self.cognito_issuer
        return f"{issuer}/.well-known/jwks.json" if issuer else ""


settings = Settings()
