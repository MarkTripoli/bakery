# Bakery entity relationship diagrams

Generated from ../data-model.json. All 69 tables and 160 declared FK relationships appear in all.svg; all.mmd is its editable Mermaid source. The technical map embeds the SVG views so the diagrams work offline.

core.svg shows eight core work/execution tables and their internal links. Each of the 15 domain files includes all fields of its own tables and PK-only context for referenced tables. Common timestamps and version fields are omitted visually.

PK denotes a primary key and FK a foreign key. The parent end reflects FK nullability. The child end is zero-or-many except the explicitly unique worker host principal. Conditional uniqueness, ownership/XOR constraints and deletion rules remain in the entity inventory; do not infer cascading deletes from the diagram. See Mermaid's notation at https://mermaid.js.org/syntax/entityRelationshipDiagram.html#relationship-syntax.
