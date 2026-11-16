# Handling Stalled Herdr Terminal Panes

1. First confirm ownership: panes with ownedBy human allow read-only diagnostics and notifications only; no keystrokes or aborts;
2. A long-unflipped state does not prove no progress; verify the facts read-only first; never auto-abort based on duration alone;
3. Blocked panes awaiting permission confirmation go to the approval bridge (AskDoc); do not confirm on the human's behalf;
4. When there is long-standing no progress and a safe retry is possible, suggest re-dispatching the task instead of blindly injecting keystrokes.
