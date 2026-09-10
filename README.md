# live-agency-creator-profile-record

Independent Skill repository. [SKILL.md](SKILL.md) owns its behavior and acceptance contract.

Run `npm test` after installing the parent development composition. Provider discovery tests select the shared synthetic fixture installation explicitly. This repository owns its source, package manifest and focused tests.

The version 2 archive contains only the selected-environment workflow and neutral
contracts. Legacy scripts/tests remain source-only comparison material, with
their concrete dependencies restricted to development. Existing callers of the
version 1 script exports must retain version 1.2.0 until explicitly migrated;
version 2 is a breaking package boundary. Runtime is supplied by the selected
environment, not declared as an installable dependency or peer of this Skill.
Execution still requires that compatible Runtime; standalone installation must
not install Runtime or concrete Providers.

For published 2.0.0-m3.0, the inspected registry metadata included the Runtime
peer dependency but omitted its optional metadata; standalone registry
verification then attempted Runtime access and received 403. Version 2.0.0-m3.1
removes that peer declaration. Publication checks inspect both the standalone
archive installation and registry installation lockfiles for unintended Runtime
or concrete Provider packages. The published 2.0.0-m3.0 artifact is preserved.
