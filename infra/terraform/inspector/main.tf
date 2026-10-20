terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "account_id" {
  description = "Target AWS account ID for the Inspector test pool."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account ID."
  }
}

provider "aws" {
  region              = "us-east-1"
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = { project = "homie", purpose = "local-mcp-inspector" }
  }
}

locals {
  name        = "homie-inspector-${var.account_id}"
  tools_scope = "${aws_cognito_resource_server.mcp.identifier}/mcp:tools"
}

resource "aws_cognito_user_pool" "inspector" {
  name                     = local.name
  user_pool_tier           = "LITE"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

resource "aws_cognito_user_pool_domain" "inspector" {
  domain                = local.name
  user_pool_id          = aws_cognito_user_pool.inspector.id
  managed_login_version = 1
}

resource "aws_cognito_resource_server" "mcp" {
  identifier   = "homie"
  name         = "homie-mcp-inspector"
  user_pool_id = aws_cognito_user_pool.inspector.id

  scope {
    scope_name        = "mcp:tools"
    scope_description = "Use Homie memory tools as the signed-in user"
  }
}

resource "aws_cognito_user_pool_client" "inspector" {
  name                                 = "inspector-local"
  user_pool_id                         = aws_cognito_user_pool.inspector.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = [local.tools_scope]
  callback_urls                        = ["http://localhost:8765/auth/callback"]
  supported_identity_providers         = ["COGNITO"]
  prevent_user_existence_errors        = "ENABLED"
}

output "aws_region" {
  value = "us-east-1"
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.inspector.id
}

output "cognito_issuer" {
  value = "https://cognito-idp.us-east-1.amazonaws.com/${aws_cognito_user_pool.inspector.id}"
}

output "cognito_domain_url" {
  value = "https://${aws_cognito_user_pool_domain.inspector.domain}.auth.us-east-1.amazoncognito.com"
}

output "inspector_client_id" {
  value = aws_cognito_user_pool_client.inspector.id
}

output "mcp_tools_scope" {
  value = local.tools_scope
}
