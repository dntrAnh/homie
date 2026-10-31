# Local MCP Inspector test

This Terraform root creates a separate Cognito Lite user pool for testing the local
`/mcp` endpoint. It does not create DynamoDB, S3, a server host, or a frontend.
Its Terraform state is separate from the shared stack in the parent directory.

## 1. Confirm the target account

Choose the AWS CLI profile for the account where you want the test pool. Replace
`homie-personal` below with your profile name, then check its account ID:

```sh
export AWS_PROFILE=homie-personal
aws sts get-caller-identity --query Account --output text
```

Capture the account ID for the commands below:

```sh
HOMIE_INSPECTOR_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
```

Review the account ID before continuing. The provider checks `allowed_account_ids`
against this value, so switching to another profile before applying will fail.
Keep the local Terraform state private; it is ignored by Git.

## 2. Create the Cognito test pool

From the repository root:

```sh
terraform -chdir=infra/terraform/inspector init
terraform -chdir=infra/terraform/inspector validate
terraform -chdir=infra/terraform/inspector plan -var="account_id=$HOMIE_INSPECTOR_ACCOUNT_ID"
```

Review the plan: it should create one user pool, one domain, one resource server,
and one public app client. Then apply it:

```sh
terraform -chdir=infra/terraform/inspector apply -var="account_id=$HOMIE_INSPECTOR_ACCOUNT_ID"
```

Terraform outputs the pool ID, domain, client ID, and `homie/mcp:tools` scope. The
domain uses the classic hosted UI so the Lite pool can show Cognito's sign-in page.
No app client secret is created.

## 3. Create a test user

In the AWS console, select **us-east-1**, open **Amazon Cognito → User pools →
homie-inspector-<your account ID> → Users**, and create a user with an email address
you control. Have Cognito send its invitation, then use the temporary password
and set a permanent one at first sign-in. Public self-registration is disabled.

## 4. Run the local server

Copy `server/.env.example` to `server/.env`. Replace `COGNITO_USER_POOL_ID` with
the result of `terraform -chdir=infra/terraform/inspector output -raw cognito_user_pool_id`
and `COGNITO_CLIENT_IDS` with the result of
`terraform -chdir=infra/terraform/inspector output -raw inspector_client_id`. Keep
`PUBLIC_BASE_URL=http://localhost:8000`. Docker Compose supplies DynamoDB Local
and dummy AWS credentials to the server; it does not use the AWS DynamoDB service.

```sh
docker compose -f infra/docker-compose.yml up --build server
```

Open `http://localhost:8000/health` to check that the server is running.

## 5. Get a user token and use Inspector

Run the local one-shot sign-in helper:

```sh
python3 infra/terraform/inspector/get_token.py
```

It opens Cognito's sign-in page, receives the authorization code at
`http://localhost:8765/auth/callback`, and copies only the short-lived **access
token** to the macOS clipboard. It does not save the code or token to disk. Do
not share the token or paste it into a repo file or chat. The helper currently
requires macOS because it uses `pbcopy`.

Start the Inspector web UI:

```sh
node --version
npx @modelcontextprotocol/inspector
```

Inspector currently requires Node.js 22.19 or newer. If the local callback
browser page cannot connect after sign-in, check that port 8765 is free and
that `localhost` resolves to `127.0.0.1` on this Mac.

Add a Streamable HTTP server at `http://localhost:8000/mcp`. Under that server's
**Server Settings → Custom Headers**, set `Authorization` to `Bearer ` followed
by the pasted access token. Connect, then use **Tools** to call `remember`, `recall`, and
`forget`. A service token or ID token cannot call these personal-memory tools.
When the user access token expires, run the helper again and replace the header.
Inspector saves custom headers in its local catalog, so after testing remove
the Authorization header from Inspector and clear your clipboard.

## Clean up

When you no longer need this test pool, review the destroy plan before deleting
it. Destroying the pool also deletes its test user:

```sh
terraform -chdir=infra/terraform/inspector plan -destroy -var="account_id=$HOMIE_INSPECTOR_ACCOUNT_ID"
terraform -chdir=infra/terraform/inspector destroy -var="account_id=$HOMIE_INSPECTOR_ACCOUNT_ID"
```
