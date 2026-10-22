# Markup preset library

A preset stores an annotation tool, RGB color, line width, opacity and contents. It does not store a drawing position, callout leader, document, reviewer identity, status, lock or accepted engineering quantity. All ten current annotation tools are supported; stamp presets also retain their standard appearance name. Unicode names are supported; annotation contents retain the current Helvetica/WinAnsi restriction.

1. Choose a markup tool and fill its appearance and contents controls. You can do this before opening a PDF.
2. Enter a unique **Preset name**, then choose **Save new markup preset**.
3. Choose an entry under **Saved markup presets** and choose **Apply selected preset**. Set drawing coordinates/leader as needed, then add or draw a new markup. Applying does not edit an existing annotation and clears its selection.
4. To revise a preset, select it, set the desired controls/name and choose **Replace selected preset**. This updates the library only. **Delete selected preset** removes that library entry.
5. **Export markup presets** downloads a versioned JSON backup. **Import markup presets** merges a file into the current library. Duplicate IDs or names reject the entire import; no entries are silently overwritten. Clear the local library first if you intend to restore an identical exported backup.

Saving/importing explicitly retains preset contents unencrypted in this browser profile (the desktop app uses its own profile). This is separate from PDF recovery. Clearing retained PDFs does not remove presets. Use **Clear local preset library** to remove the local library. Export backups before clearing browser data or changing installations. Libraries are not synchronized between browsers or users.

Version 1 permits 200 presets and at most 1 MiB of JSON. Names must be 1–80 characters, without control characters, and unique after trimming, NFC normalization and lowercasing. Invalid imports, unsupported versions, storage quota errors and stale-tab writes preserve the previous library. A corrupt stored library is not silently replaced; it remains until explicitly cleared. Reload a stale tab before making changes. The stale-tab check is a guard, not a distributed concurrent-edit transaction; live shared palette editing remains future collaboration work.

Do not include confidential note templates if this device/browser profile is shared. No network transfer, script execution, formulas, macros or external resources are part of the preset format. Foreign annotation import/editing, arbitrary fonts, stamp assets, multiple named palettes and shared organization libraries remain separate unfinished workflows.
