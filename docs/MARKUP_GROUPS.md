# Markup groups

Use the checkboxes next to authored markup list entries to build a selection, then choose **Group selected markups**. A group must contain at least two annotations on one page. Selecting a member, including through its property button, includes the whole group; the selection count includes members hidden by the list filter. Existing groups can be combined by selecting their members and grouping again. Nested or cross-page groups are not supported.

Group actions commit once, so undo/redo restores the whole operation:

- **Apply selection properties** copies color, width, opacity and status from the drawing controls to the complete selection. Individual annotation type, text, author, creation time and geometry remain distinct.
- **Move markup selection** adds **Group move x/y** offsets in unrotated PDF page units, including callout leader points. Invalid/out-of-page moves reject the entire operation.
- **Lock markup selection** locks all selected members. A locked member blocks group change, movement, deletion and ungrouping. **Unlock markup selection** explicitly unlocks every selected member.
- **Delete markup selection** deletes all selected annotations. **Delete selected markup** also deletes its entire group when that selected annotation is grouped.
- **Ungroup selected markups** removes membership while preserving the individual annotations. Ungroup before using individual annotation editing; the property editor rejects individual group-member replacement.
- **Clear markup selection** clears the selection; it does not edit annotations.

Actions include entire groups even when a caller selects only one member. Malformed selections, invalid styles or locked members fail atomically. Groups do not include engineering measurements and never change calibrated takeoff geometry or accepted quantities. Presets store reusable appearance/content only, not group membership.

Groups follow page reordering, extraction and opt-in recovery with the current workspace model. PDF export writes one primary annotation and links subordinates using /IRT and /RT /Group, following [Adobe's PDF markup grouping specification](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/pdfreference1.6.pdf). Flattening draws the existing appearances and removes the authored annotation objects, so a flattened group is page content, not an editable group. Existing foreign source annotations remain separate.

CSV reports append **Group ID** as column 19 after Stamp appearance; prior column positions remain intact. PDF reports include group IDs for each member. This release is still development-only: no old-version recovery migration guarantee, foreign annotation-group import/editing, named/nested groups, interactive canvas bounding-box selection/dragging, group rotation/scaling or shared concurrent grouping is claimed. Standard links and appearances have focused parser/rendering tests; interactive grouping in independent commercial viewers remains an acceptance item.

Layer reports now append four metadata columns (20–23); Group ID stays column 19. Authored annotation layers are described in MARKUP_LAYERS.md. Group edit operations respect their layer's edit lock; unlock the layer before unlocking individual/group annotations.

Comment reports now append Comment count/Comments JSON as columns24–25, preserving the first23columns. Group members own independent discussion threads; group actions preserve them. See MARKUP_COMMENTS.md for explicit flattening and retention behavior.
