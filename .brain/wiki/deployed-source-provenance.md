# Deployed Source Provenance

## Problem

An installed package name can refer to a disabled plugin while the active service loads another absolute path. Updating the nominal repository can therefore leave the running plugin unchanged.

## Decision Method

Read plugin declarations with a YAML parser and print only id, name, disabled state and resolved package path. Never print whole credential-bearing profiles. Resolve the package directory and inspect source.bundle and SOURCE_REVISION; compare these with git remote refs before editing.

## Evidence And Reasoning

This audit found an active Task snapshot outside Git, with recoverable committed source in source.bundle. Importing that bundle into the existing repository preserved both history and unrelated working changes. An isolated Git index allowed a scoped source commit without switching the dirty checkout. Building with the service Node binary avoided native-module ABI mismatches.

## Related

See ../dev-log/runtime-source-audit-20261002.md for the audit limits. A GitHub archive branch preserves provenance but is not a main merge or proof of service reload.

## Expiry

Recorded 2026-10-02. Recheck when plugin profile paths, deployment packaging, or service Node versions change.
