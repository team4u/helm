# CI Failure Handling

1. Read the failure-stage log summary and distinguish compile errors, test failures, and environment problems;
2. Compile/test failures: record the failure context and a coding Profile suggestion; the hub or a human decides the dispatch;
3. Environment problems (missing dependencies, occupied ports): give a clear diagnosis; do not retry blindly;
4. After a fix, rerun the gate command to confirm; never declare success based on model output alone.
