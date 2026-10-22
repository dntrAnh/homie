class SimulatorServiceError(Exception):
    """Base class for simulator failures safe for the HTTP route to translate."""


class InvalidModelOutputError(SimulatorServiceError):
    """Bedrock returned a malformed, empty, or incomplete response."""


class UpstreamUnavailableError(SimulatorServiceError):
    """Bedrock or MCP is temporarily unavailable."""


class SimulatorTimeoutError(SimulatorServiceError):
    """Bedrock, MCP, or the overall simulator request timed out."""
