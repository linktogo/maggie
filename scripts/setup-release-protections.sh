#!/usr/bin/env bash
# One-time setup for the repository's release tag protection. Run by hand,
# once. Requires repo-admin `gh` auth.
#
# `linktogo` is a personal GitHub account, not an organization, so there is
# no Teams feature to gate on: tag creation is restricted to the
# repository's Admin role (which today only `linktogo` holds). Automated
# tagging (.github/workflows/prepare-release.yml) authenticates as that same
# account via the RELEASE_PAT repository secret, so it satisfies this
# restriction too — see "Tagging and publishing" in CONTRIBUTING.md.
#
# Publishing to npm (.github/workflows/publish.yml) has no equivalent gate:
# it runs unattended once a GitHub Release is published.
set -euo pipefail

OWNER="linktogo"
REPO="maggie"
USER="linktogo"

echo "Configuring tag ruleset restricting v* tag creation to the repository Admin role..."
gh api --method POST "repos/$OWNER/$REPO/rulesets" --input - >/dev/null <<'JSON'
{
  "name": "release-tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [{ "type": "creation" }],
  "bypass_actors": [
    { "actor_type": "RepositoryRole", "actor_id": 5, "bypass_mode": "always" }
  ]
}
JSON
echo "Ruleset configured — only accounts with the Admin role (today: $USER) can create v* tags."

echo
echo "Manual step required: create a fine-grained personal access token for"
echo "$USER, scoped to $OWNER/$REPO only with Contents: Read and write"
echo "permission, then add it as the RELEASE_PAT repository secret:"
echo "  gh secret set RELEASE_PAT --repo $OWNER/$REPO"
echo "prepare-release.yml uses it to push release tags on $USER's behalf,"
echo "which is what lets automated tag creation bypass the ruleset above."
echo
echo "Done. Verify the ruleset under Settings > Rules on the repo."
