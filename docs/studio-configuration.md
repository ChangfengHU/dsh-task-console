# Configure the packaged Studio helpers

After installing the DSH Task Console package, run its local configuration command with existing host paths:

```sh
node /path/to/dsh-task-console/scripts/configure-studio.mjs \
  --output '/home/alex/private/studio-host.json' \
  --runtime '/home/alex/render runtime' \
  --profile '/home/alex/.dsh/profiles/web/cordis.patch.yml' \
  --vault-token-file '/home/alex/private/vault-token' \
  --cache-root '/home/alex/private/observation-cache'
```

This defaults to a dry run. It verifies the package's helper/import and role-file hashes, checks that the supplied local files/directories and renderer package files exist, and prints the proposed configuration. Profile and token contents are not read. It does not contact providers or install dependencies, roles or credentials.

Add `--install` to create the proposed config atomically with mode `0600`. The output parent and cache directory must already exist. An existing output is always refused, including an identical file; use a new versioned output path to preserve the previous configuration. No DSH profile or service is modified.

Point the existing DSH Task Console plugin configuration at the result:

```yaml
config:
  studioConfigPath: /home/alex/private/studio-host.json
```

The command also prints this exact configuration field. The host rejects a missing or malformed explicitly selected file. Omitting the field retains the legacy package-adjacent lookup.

If genuine calibration evidence is available, supply both `--calibration-path` and `--regression-path`. Missing proof files are reported as missing; present files remain unverified until the existing host calibration checks validate their contents. The command never creates calibration records or declares a render, provider, role installation or video-quality check passed. Node/Chrome/ffprobe availability and actual rendering still need host verification.
