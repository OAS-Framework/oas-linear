# Decisions

* [Config templates ship outside capability roots and contain no deployment-local values](config-templates-outside-capability-roots.md) - oas-linear ships templates under config-templates/ rather than inside a capability root, and mechanically rejects values that belong to a specific deployment.
* [oas.linear 2.0.0 is the compatibility-floor release for OAS 0.20](oas-linear-v2-compatibility-major.md) - Raising compatibility.oas to >=0.20.0 is a breaking consumer-contract change, so oas-linear moves from 1.0.0 to 2.0.0 while keeping the v1 tag immutable.
* [The test-script gate runs the suites itself](test-script-gate-runs-suites.md) - oas-linear's test script invokes the gate without naming suites, and the gate inventories test files and spawns node --test with argv under shell:false.
