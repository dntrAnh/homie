"""Sign in to the test Cognito pool and copy a user access token for MCP Inspector."""

import base64
import hashlib
import hmac
import json
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REDIRECT_URI = "http://localhost:8765/auth/callback"
TIMEOUT_SECONDS = 300


def terraform_output(name: str) -> str:
    result = subprocess.run(
        ["terraform", f"-chdir={ROOT}", "output", "-raw", name],
        capture_output=True,
        check=True,
        text=True,
    )
    return result.stdout.strip()


def copy_access_token(token: str) -> None:
    subprocess.run(["pbcopy"], input=token, check=True, text=True)


def main() -> None:
    try:
        domain = terraform_output("cognito_domain_url")
        client_id = terraform_output("inspector_client_id")
        scope = terraform_output("mcp_tools_scope")
    except (OSError, subprocess.CalledProcessError) as exc:
        raise RuntimeError(
            "Apply the Inspector Cognito Terraform setup first."
        ) from exc

    verifier = secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b"=")
    state = secrets.token_urlsafe(32)
    result: dict[str, str] = {}

    class CallbackHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            callback = urllib.parse.urlsplit(self.path)
            if callback.path != "/auth/callback":
                self.send_error(404)
                return

            params = urllib.parse.parse_qs(callback.query)
            returned_state = params.get("state", [""])[0]
            if not hmac.compare_digest(returned_state, state):
                self.send_error(400, "Invalid sign-in state")
                return

            if "error" in params:
                result["error"] = params["error"][0]
                message = "Sign-in failed. Return to the terminal for details."
            elif code := params.get("code", [""])[0]:
                result["code"] = code
                message = (
                    "Sign-in received. Return to the terminal, then open MCP Inspector."
                )
            else:
                self.send_error(400, "Missing authorization code")
                return

            body = message.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            # The callback URL contains a one-time authorization code.
            pass

    try:
        server = HTTPServer(("127.0.0.1", 8765), CallbackHandler)
    except OSError as exc:
        raise RuntimeError("Local callback port 8765 is unavailable.") from exc

    authorize_url = f"{domain}/oauth2/authorize?" + urllib.parse.urlencode(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": REDIRECT_URI,
            "scope": scope,
            "code_challenge_method": "S256",
            "code_challenge": challenge.decode(),
            "state": state,
        }
    )

    print("Opening Cognito sign-in for the test user you created in the AWS console.")
    if not webbrowser.open(authorize_url):
        print(f"Open this URL in your browser: {authorize_url}")

    deadline = time.monotonic() + TIMEOUT_SECONDS
    server.timeout = 1
    with server:
        while not result and time.monotonic() < deadline:
            server.handle_request()

    if "error" in result:
        raise RuntimeError(f"Cognito sign-in failed: {result['error']}")
    if "code" not in result:
        raise RuntimeError("Sign-in timed out. Run the helper again to retry.")

    request = urllib.request.Request(
        f"{domain}/oauth2/token",
        data=urllib.parse.urlencode(
            {
                "grant_type": "authorization_code",
                "client_id": client_id,
                "redirect_uri": REDIRECT_URI,
                "code": result["code"],
                "code_verifier": verifier,
            }
        ).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            tokens = json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Cognito token exchange failed (HTTP {exc.code}).") from exc

    token = tokens.get("access_token")
    if not isinstance(token, str) or not token:
        raise RuntimeError("Cognito did not return a user access token.")
    copy_access_token(token)
    print(
        "User access token copied to your clipboard. Paste it into Inspector's Bearer header."
    )
    print(
        "Run this helper again when the token expires; it does not save tokens to disk."
    )


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, urllib.error.URLError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
