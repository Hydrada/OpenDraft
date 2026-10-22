# Visual review stamps

Choose **stamp** under **Markup tool**, then select **Stamp appearance**. Enter two box corners or drag a box on the drawing. All 14 standard PDF stamp names are available. Leave **Markup contents** blank for the standard name in uppercase with word spacing, or enter custom text (including explicit newlines). Color, line width, opacity, author, status and locking use the existing markup controls.

Stamp lettering uses Helvetica-Bold and fits the box from 36 down to 8 points, wrapping when necessary. If it cannot fit at 8 points, the operation fails visibly; enlarge the box or shorten the text. The current WinAnsi text restriction applies. Oversized notes do not silently clip or disappear. Text stamp assets and borders are independently drawn; no commercial stamp artwork is copied.

Save a stamp tool/style/contents using the [preset library](MARKUP_PRESETS.md); its standard appearance name is retained. Presets do not retain box coordinates, reviewer identity, lock or status. Existing version 1 non-stamp preset files remain supported; older applications without stamp support may reject new stamp tools explicitly.

Authored stamps participate in undo/redo, locking, editable local recovery and authored-only flattening. PDF export uses /Subtype /Stamp, its standard /Name and an explicit normal appearance stream. CSV reports retain **Stamp appearance** as column 18, followed by **Group ID** as column 19; PDF reports include the appearance name even when contents is blank. Consumers of the earlier CSV format must accept the appended columns; earlier column order is unchanged.

A visual review stamp does not establish verified identity, authorization, engineering acceptance or a cryptographic digital signature. An appearance named Approved is a user's visible review mark, not an enforced approval workflow. Existing apparently signed/certified documents retain their rewrite protections.

Custom image/PDF stamp artwork, dynamic date/name fields, arbitrary fonts, stamp rotation independent of the page, verified digital signatures and managed approval workflows remain unfinished. The implemented stamp workflow is text-based. Foreign PDF annotations are displayed, not imported into the editable list.

Specification reference: [PDF 32000-1:2008, Table 181](https://opensource.adobe.com/dc-acrobat-sdk-docs/standards/pdfstandards/pdf/PDF32000_2008.pdf) documents the standard names and precedence of explicit appearance streams. Web extraction of the full PDF exceeded the tool's size limit; the indexed Table 181 passage and Adobe SDK annotation references were consulted, rather than claiming a full-spec download.

Authored-layer reports append metadata columns 20–23; Stamp appearance and Group ID remain columns 18 and 19. See MARKUP_LAYERS.md for layer assignment, visibility and edit locks.
