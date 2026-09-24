# Studio helper payload

These owned Python helpers are distributed under the package MIT license. They are copied from an explicit development source list; hashes are in manifest.json. No parent checkout is needed after packing.

This is not an installed or validated Studio runtime. Python 3.10+ on POSIX, Node, ffmpeg/ffprobe, Chrome, the render runtime, DSH profile, provider access and host credential references remain host responsibilities. Helpers retain legacy default paths; configure the host explicitly. The six public role templates are hash-covered by this manifest and retain their own role contract validation. Required Skills remain separate host dependencies; packaging does not install or grant role capabilities.

The host must supply speech-calibration.json and speech-differential-regression.json from genuine calibration, with their existing validation. Private historical proof snapshots are deliberately excluded. Missing proofs mean unverified, never calibration passed. Task media and compiler input files are not package assets.
