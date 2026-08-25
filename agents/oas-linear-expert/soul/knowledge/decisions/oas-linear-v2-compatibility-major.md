---
type: Decision
title: oas.linear 2.0.0 is the compatibility-floor release for OAS 0.20
description: Raising compatibility.oas to >=0.20.0 is a breaking consumer-contract change, so oas-linear moves from 1.0.0 to 2.0.0 while keeping the v1 tag immutable.
tags: [oas, oas-linear, versioning, release, compatibility]
timestamp: 2026-08-20
---

# Decision

`oas.linear` moves from `1.0.0` to `2.0.0`, and the single capability manifest version moves with the package version.

# Why major

The compatibility floor rises from `>=0.19.0` to `>=0.20.0`. A 0.19 kernel can no longer consume the package at all. Breaking the set of hosts that can install a package is a breaking consumer-contract change even when command behavior is otherwise unchanged.

The release also adopts the canonical `configTemplates` spelling, which a 0.19 reader does not understand.

# Constraint

The published `v1.0.0` tag remains immutable and untouched so 0.19 deployments can keep using a working pin. Do not retarget older tags as an upgrade mechanism.
