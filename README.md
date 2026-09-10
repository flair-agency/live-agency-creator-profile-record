# live-agency-creator-profile-record

Independent Skill repository. [SKILL.md](SKILL.md) owns its behavior and acceptance contract.

Run `npm test` after installing the parent development composition. Provider discovery tests select the shared synthetic fixture installation explicitly. This repository owns its source, package manifest and focused tests.

The version 2 archive contains only the selected-environment workflow and neutral
contracts. Legacy scripts/tests remain source-only comparison material, with
their concrete dependencies restricted to development. Existing callers of the
version 1 script exports must retain version 1.2.0 until explicitly migrated;
version 2 is a breaking package boundary. Runtime is an optional peer so installing
this Skill alone does not install a Runtime or Providers. Execution requires the
compatible Runtime supplied by the selected environment.
