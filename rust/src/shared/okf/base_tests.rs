//! Ported from the engine half of `test/bases.test.ts`.

use super::*;
use crate::okf::parser::parse_yaml;
use serde_json::json;

const NOW: f64 = 1_768_478_400_000.0; // 2026-01-15T12:00:00Z

fn row(path: &str, fm: Json, links: Vec<(&str, Option<&str>)>) -> BaseRow {
    let wiki = path.trim_start_matches("wiki/");
    BaseRow {
        path: path.into(),
        wiki_path: wiki.into(),
        id: wiki.trim_end_matches(".md").into(),
        mtime_ms: 1_768_003_200_000.0,
        frontmatter: fm.as_object().cloned().unwrap_or_default(),
        links: links
            .into_iter()
            .map(|(t, r)| (t.to_string(), r.map(str::to_string)))
            .collect(),
    }
}

fn rows() -> Vec<BaseRow> {
    vec![
        row(
            "wiki/1-projects/alpha.md",
            json!({"type": "Project", "title": "Alpha", "tags": ["Product", "web"], "price": 10, "due": "2026-02-01"}),
            vec![],
        ),
        row(
            "wiki/1-projects/beta.md",
            json!({"type": "Project", "title": "Beta", "tags": ["DEAD"], "price": 30}),
            vec![],
        ),
        row(
            "wiki/2-areas/gamma.md",
            json!({"type": "Concept", "title": "Gamma", "tags": ["Product"], "price": 20, "status": "done"}),
            vec![],
        ),
        row(
            "wiki/notes/delta.md",
            json!({"type": "Concept", "title": "Delta", "tags": "web, misc", "status": "open"}),
            vec![("alpha", Some("1-projects/alpha"))],
        ),
    ]
}

fn yaml(text: &str) -> Json {
    parse_yaml(text).expect("valid yaml")
}

fn run(text: &str) -> BaseResult {
    run_base(
        &yaml(text),
        &rows(),
        &RunOptions {
            view: None,
            limit: None,
            now: NOW,
        },
    )
    .unwrap()
}

fn run_with(text: &str, view: Option<&str>, limit: Option<usize>) -> Result<BaseResult, String> {
    run_base(
        &yaml(text),
        &rows(),
        &RunOptions {
            view,
            limit,
            now: NOW,
        },
    )
}

fn first_cells(r: &BaseResult) -> Vec<Json> {
    r.rows
        .as_ref()
        .unwrap()
        .iter()
        .map(|x| x.cells[0].clone())
        .collect()
}

#[test]
fn no_views_gives_an_implicit_table_ordered_by_path() {
    let r = run("");
    assert_eq!(r.kind, "table");
    assert_eq!(r.view, "Table");
    assert_eq!(
        r.columns,
        vec![BaseColumn {
            id: "file.name".into(),
            name: "file.name".into()
        }]
    );
    let paths: Vec<&str> = r
        .rows
        .as_ref()
        .unwrap()
        .iter()
        .map(|x| x.path.as_str())
        .collect();
    assert_eq!(
        paths,
        [
            "wiki/1-projects/alpha.md",
            "wiki/1-projects/beta.md",
            "wiki/2-areas/gamma.md",
            "wiki/notes/delta.md"
        ]
    );
    assert_eq!(r.total, 4);
}

#[test]
fn filters_combine_and_not_means_none_of_them() {
    let r = run(
        "filters:\n  or:\n    - file.hasTag(\"Product\")\n    - file.hasTag(\"web\")\nviews:\n  - type: table\n    name: T\n    filters:\n      and:\n        - 'price != 30'\n        - not:\n            - 'status == \"open\"'\n    order: [file.basename]\n",
    );
    assert_eq!(first_cells(&r), [json!("alpha"), json!("gamma")]);
    let r = run(
        "filters:\n  not:\n    - file.hasTag(\"Product\")\n    - file.hasTag(\"DEAD\")\nviews: [{type: table, name: T, order: [file.basename]}]\n",
    );
    assert_eq!(first_cells(&r), [json!("delta")]);
}

#[test]
fn formulas_display_names_sort_and_limit() {
    let r = run(
        "formulas:\n  double: price * 2\n  label: 'title + \" (\" + formula.double + \")\"'\nproperties:\n  formula.label:\n    displayName: Label\nviews:\n  - type: table\n    name: T\n    filters: price\n    order: [formula.label, price]\n    sort:\n      - property: price\n        direction: DESC\n    limit: 2\n",
    );
    assert_eq!(r.columns[0].name, "Label");
    assert_eq!(r.columns[1].name, "price");
    let cells: Vec<Vec<Json>> = r
        .rows
        .as_ref()
        .unwrap()
        .iter()
        .map(|x| x.cells.clone())
        .collect();
    assert_eq!(
        cells,
        [
            vec![json!("Beta (60)"), json!(30)],
            vec![json!("Gamma (40)"), json!(20)]
        ]
    );
    assert_eq!((r.total, r.shown), (3, 2));
}

#[test]
fn a_limit_argument_only_narrows() {
    let text = "views: [{type: table, name: T, limit: 3}]";
    assert_eq!(run_with(text, None, Some(2)).unwrap().shown, 2);
    assert_eq!(run_with(text, None, Some(10)).unwrap().shown, 3);
}

#[test]
fn empty_values_sort_last_in_both_directions() {
    let r = run("views:\n  - type: table\n    name: T\n    order: [file.basename]\n    sort: [{property: price, direction: DESC}]\n");
    assert_eq!(
        first_cells(&r),
        [
            json!("beta"),
            json!("gamma"),
            json!("alpha"),
            json!("delta")
        ]
    );
    let r = run("views:\n  - type: table\n    name: T\n    order: [file.basename]\n    sort: [{property: price}]\n");
    assert_eq!(
        first_cells(&r),
        [
            json!("alpha"),
            json!("gamma"),
            json!("beta"),
            json!("delta")
        ]
    );
}

#[test]
fn group_by_gives_ordered_groups_with_summaries() {
    let r = run(
        "formulas:\n  bucket: 'if(file.hasTag(\"Product\"), \"Product\", \"Other\")'\nviews:\n  - type: cards\n    name: C\n    groupBy:\n      property: formula.bucket\n      direction: DESC\n    order: [file.basename, price]\n    summaries:\n      price: Sum\n      file.basename: Count\n",
    );
    assert_eq!(r.kind, "cards");
    assert!(r.rows.is_none());
    let groups = r.groups.as_ref().unwrap();
    assert_eq!(
        groups
            .iter()
            .map(|g| (g.key.clone(), g.count))
            .collect::<Vec<_>>(),
        [(json!("Product"), 2), (json!("Other"), 2)]
    );
    let s = |c: &str, n: &str, v: Json| BaseSummary {
        column: c.into(),
        summary: n.into(),
        value: v,
    };
    assert_eq!(
        groups[0].summaries,
        [
            s("file.basename", "Count", json!(2)),
            s("price", "Sum", json!(30))
        ]
    );
    assert_eq!(
        r.summaries,
        [
            s("file.basename", "Count", json!(4)),
            s("price", "Sum", json!(60))
        ]
    );
}

#[test]
fn default_and_custom_summaries() {
    let r = run(
        "views:\n  - type: table\n    name: T\n    order: [price, status, due, tags]\n    summaries:\n      price: Average\n      status: Filled\n      due: Latest\n      tags: Unique\n",
    );
    let by: Vec<(String, Json)> = r
        .summaries
        .iter()
        .map(|s| (s.column.clone(), s.value.clone()))
        .collect();
    assert_eq!(by[0], ("price".into(), json!(20)));
    assert_eq!(by[1], ("status".into(), json!(2)));
    assert_eq!(by[2], ("due".into(), json!("2026-02-01")));
    assert_eq!(by[3], ("tags".into(), json!(4)));

    let custom = run(
        "summaries:\n  doubled: 'values.sum() * 2'\nviews: [{type: table, name: T, order: [price], summaries: {price: doubled}}]\n",
    );
    assert_eq!(custom.summaries[0].value, json!(120));
    for (name, want) in [
        ("Median", json!(20)),
        ("Min", json!(10)),
        ("Max", json!(30)),
        ("Range", json!(20)),
    ] {
        let r = run(&format!(
            "views: [{{type: table, name: T, order: [price], summaries: {{price: {name}}}}}]"
        ));
        assert_eq!(r.summaries[0].value, want, "{name}");
    }
    let r = run("views: [{type: table, name: T, order: [price], summaries: {price: Stddev}}]");
    assert_eq!(r.summaries[0].value, json!((200.0_f64 / 3.0).sqrt()));
}

#[test]
fn views_are_picked_by_name() {
    let text = "views:\n  - {type: table, name: One, order: [file.basename]}\n  - {type: cards, name: Two}\n  - {type: list, name: Three}\n";
    assert_eq!(run(text).view, "One");
    assert_eq!(run_with(text, Some("Two"), None).unwrap().kind, "cards");
    assert_eq!(
        run_with(text, Some("Nope"), None).unwrap_err(),
        "view 'Nope' not found; available: One, Two, Three"
    );
    assert!(run_with(text, Some("Three"), None)
        .unwrap_err()
        .contains("not supported"));
    assert_eq!(
        list_views(&yaml(text)),
        [
            ("One".to_string(), "table".to_string()),
            ("Two".into(), "cards".into()),
            ("Three".into(), "list".into())
        ]
    );
}

#[test]
fn runtime_errors_become_empty_values_plus_a_warning() {
    let r = run("formulas:\n  bad: 'title - 1'\nviews:\n  - {type: table, name: T, order: [formula.bad, file.size]}\n");
    assert_eq!(r.rows.as_ref().unwrap()[0].cells, [Json::Null, Json::Null]);
    assert_eq!(
        r.warnings,
        [
            "formula.bad: cannot apply '-' to string and number",
            "column file.size: file.size is not supported"
        ]
    );
}

const DOC_EXAMPLE: &str = r#"
filters:
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
        - file.inFolder("Required Reading")
formulas:
  formatted_price: 'if(price, price.toFixed(2) + " dollars")'
  ppu: "(price / age).toFixed(2)"
properties:
  status:
    displayName: Status
  formula.formatted_price:
    displayName: "Price"
  file.ext:
    displayName: Extension
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table
    name: "My table"
    limit: 10
    groupBy:
      property: note.age
      direction: DESC
    filters:
      and:
        - 'status != "done"'
        - or:
            - "formula.ppu > 5"
            - "price > 2.50"
    order:
      - file.name
      - file.ext
      - note.age
      - formula.ppu
      - formula.formatted_price
    summaries:
      formula.ppu: Average
      formula.formatted_price: customAverage
  - type: list
    name: "Other layout"
    unknownKey: [1, 2]
unknownTopLevel: kept
"#;

#[test]
fn an_obsidian_authored_example_reads() {
    let value = yaml(DOC_EXAMPLE);
    assert_eq!(
        validate_base(&value),
        Findings {
            errors: vec![],
            warnings: vec!["views[1]: type 'list' is not supported (table and cards only)".into()]
        }
    );
    let r = run_base(
        &value,
        &rows(),
        &RunOptions {
            view: None,
            limit: None,
            now: NOW,
        },
    )
    .unwrap();
    assert_eq!(r.view, "My table");
    assert_eq!(
        r.columns
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["file.name", "Extension", "age", "ppu", "Price"]
    );
    assert_eq!(r.total, 2);
}

fn errors(text: &str) -> Vec<String> {
    validate_base(&yaml(text)).errors
}

#[test]
fn structure_errors_are_specific() {
    assert_eq!(
        validate_base(&json!("text")).errors,
        ["a base must be a YAML mapping"]
    );
    assert_eq!(
        errors("filters: 5"),
        ["filters: must be an expression or an and / or / not mapping"]
    );
    assert_eq!(
        errors("filters: {xor: []}"),
        ["filters: unknown key 'xor' (use and, or, not)"]
    );
    assert_eq!(
        errors("formulas: [a]"),
        ["formulas: must be a mapping of name to expression"]
    );
    assert_eq!(errors("views: {a: 1}"), ["views: must be a list"]);
    assert_eq!(errors("views: [{name: x}]"), ["views[0]: type is required"]);
    assert_eq!(
        errors("views: [{type: table, limit: 0}]"),
        ["views[0].limit: must be a positive integer"]
    );
    assert_eq!(
        errors("views: [{type: table, order: x}]"),
        ["views[0].order: must be a list of property names"]
    );
    assert_eq!(
        errors("views: [{type: table, sort: [{property: a, direction: UP}]}]"),
        ["views[0].sort[0]: direction must be ASC or DESC"]
    );
    assert_eq!(
        errors("views: [{type: table, groupBy: a}]"),
        ["views[0].groupBy: must be a mapping with a property"]
    );
    assert_eq!(
        errors("views: [{type: table, summaries: {a: Nope}}]"),
        ["views[0].summaries.a: unknown summary 'Nope'"]
    );
    assert_eq!(validate_base(&yaml("")), Findings::default());
    assert_eq!(validate_base(&yaml("views: []")), Findings::default());
}

#[test]
fn expression_errors_name_where_they_are() {
    assert_eq!(
        errors("formulas: {a: '1 +'}"),
        ["formulas.a: unexpected end of expression"]
    );
    assert_eq!(
        errors("filters: 'a ='"),
        ["filters: unexpected character '='"]
    );
    assert_eq!(
        errors("filters: 'nosuch(1)'"),
        ["filters: unknown function 'nosuch'"]
    );
    assert_eq!(
        errors("views: [{type: table, filters: 'x.foo()'}]"),
        ["views[0].filters: unknown function 'foo'"]
    );
}

#[test]
fn cycles_are_errors_and_unsupported_features_are_warnings() {
    assert_eq!(
        errors("formulas: {a: 'formula.b', b: 'formula.a', c: '1'}"),
        [
            "formulas.a: circular reference",
            "formulas.b: circular reference"
        ]
    );
    let warn = |t: &str| validate_base(&yaml(t)).warnings;
    assert_eq!(
        warn("formulas: {a: 'formula.zzz'}"),
        ["formulas.a: formula.zzz is not defined"]
    );
    assert_eq!(
        warn("filters: 'file.size > 1'"),
        ["filters: file.size is not supported"]
    );
    assert_eq!(
        warn("filters: 'file.nosuch'"),
        ["filters: file.nosuch is not a known file property"]
    );
    assert_eq!(
        warn("filters: 'random() > 1'"),
        ["filters: random() is not supported"]
    );
}

#[test]
fn running_an_invalid_base_reports_every_error_at_once() {
    let err = run_base(
        &yaml("filters: 5\nviews: 3"),
        &rows(),
        &RunOptions {
            view: None,
            limit: None,
            now: NOW,
        },
    )
    .unwrap_err();
    assert_eq!(
        err,
        "invalid base: filters: must be an expression or an and / or / not mapping; views: must be a list"
    );
}

#[test]
fn markdown_for_a_grouped_table_and_for_no_rows() {
    let r = run(
        "views:\n  - type: table\n    name: By status\n    order: [file.basename, tags]\n    groupBy: {property: status}\n    summaries: {file.basename: Count}\n",
    );
    assert_eq!(
        render_base_markdown(&r),
        [
            "**By status** (table) - 4 of 4 rows",
            "",
            "### done (1)",
            "",
            "| file.basename | tags |",
            "| --- | --- |",
            "| gamma | Product |",
            "",
            "Summary: file.basename Count = 1",
            "",
            "### open (1)",
            "",
            "| file.basename | tags |",
            "| --- | --- |",
            "| delta | web, misc |",
            "",
            "Summary: file.basename Count = 1",
            "",
            "### (empty) (2)",
            "",
            "| file.basename | tags |",
            "| --- | --- |",
            "| alpha | Product, web |",
            "| beta | DEAD |",
            "",
            "Summary: file.basename Count = 2",
            "",
            "Summary: file.basename Count = 4",
        ]
        .join("\n")
    );
    assert_eq!(
        render_base_markdown(&run("filters: 'price > 999'")),
        "**Table** (table) - 0 of 0 rows\n\n(no rows)"
    );
}

// ---- limits: hostile input must come back as errors and warnings, quickly ---------------

/// The Windows main thread has 1 MB of stack; every hostile case must fit in that.
fn small_stack<F: FnOnce() + Send + 'static>(f: F) {
    std::thread::Builder::new()
        .stack_size(1 << 20)
        .spawn(f)
        .unwrap()
        .join()
        .unwrap();
}

fn within(f: impl FnOnce()) {
    let start = std::time::Instant::now();
    f();
    assert!(
        start.elapsed() < std::time::Duration::from_secs(10),
        "took {:?}",
        start.elapsed()
    );
}

fn chain(n: usize) -> Json {
    let mut m = Map::new();
    for i in 0..n {
        let src = if i == n - 1 {
            "1".to_string()
        } else {
            format!("formula.f{} + 1", i + 1)
        };
        m.insert(format!("f{i}"), Json::String(src));
    }
    json!({ "formulas": Json::Object(m) })
}

#[test]
fn validation_reports_a_deep_expression_instead_of_overflowing() {
    small_stack(|| {
        within(|| {
            let src = vec!["1"; 50_000].join(" + ");
            let found = validate_base(&json!({ "filters": src }));
            assert_eq!(
                found.errors,
                ["filters: expression is nested too deeply"]
            );
        });
    });
}

#[test]
fn a_hostile_cell_becomes_an_empty_value_and_a_warning() {
    small_stack(|| {
        within(|| {
            let filtered = run(
                "views:\n  - type: table\n    name: T\n    filters: '\"x\".repeat(10000).repeat(10000).isEmpty()'\n",
            );
            assert_eq!(filtered.total, 0);
            assert!(filtered
                .warnings
                .contains(&"filter: value is too large".to_string()));

            let cells = run("formulas:\n  boom: '\"x\".repeat(10000).repeat(10000)'\nviews:\n  - type: table\n    name: T\n    order: [file.basename, formula.boom]\n");
            let col: Vec<Json> = cells
                .rows
                .as_ref()
                .unwrap()
                .iter()
                .map(|r| r.cells[1].clone())
                .collect();
            assert_eq!(col, vec![Json::Null; 4]);
            assert!(cells
                .warnings
                .contains(&"formula.boom: value is too large".to_string()));
        });
    });
}

#[test]
fn the_step_budget_is_shared_by_the_whole_query() {
    small_stack(|| {
        within(|| {
            let h = r#""x".repeat(100).split("")"#;
            let r = run(&format!("formulas:\n  slow: '{h}.map({h}.map({h}.map(value))).length'\nviews:\n  - type: table\n    name: T\n    order: [file.basename, formula.slow]\n"));
            assert!(r
                .warnings
                .iter()
                .any(|w| w.ends_with("evaluation budget exceeded")));
        });
    });
}

#[test]
fn formula_chains_a_long_chain_is_an_error_and_a_long_ring_is_reported_quickly() {
    small_stack(|| {
        within(|| {
            assert!(validate_base(&chain(32)).errors.is_empty());
            assert_eq!(
                validate_base(&chain(10_000)).errors,
                ["formulas.f0: references are nested more than 32 deep"]
            );

            let mut ring = Map::new();
            for i in 0..5000 {
                ring.insert(
                    format!("r{i}"),
                    Json::String(format!("formula.r{}", (i + 1) % 5000)),
                );
            }
            let found = validate_base(&json!({ "formulas": Json::Object(ring) }));
            assert_eq!(found.errors.len(), 5000);
            assert_eq!(found.errors[0], "formulas.r0: circular reference");

            let mut lines = String::from("formulas:\n");
            for (k, v) in chain(32)["formulas"].as_object().unwrap() {
                lines.push_str(&format!("  {k}: '{}'\n", v.as_str().unwrap()));
            }
            lines.push_str(
                "views:\n  - type: table\n    name: T\n    order: [formula.f0]\n    limit: 1\n",
            );
            let r = run(&lines);
            assert_eq!(r.rows.unwrap()[0].cells[0], json!(32));
        });
    });
}

#[test]
fn nan_sorts_after_the_numbers_and_before_empty_values() {
    let base = "formulas:\n  v: 'if(file.basename == \"beta\", 0 / 0, price)'\nviews:\n  - type: table\n    name: T\n    order: [file.basename]\n";
    let sorted = run(&format!("{base}    sort: [{{property: formula.v}}]\n"));
    assert_eq!(
        first_cells(&sorted),
        [
            json!("alpha"),
            json!("gamma"),
            json!("beta"),
            json!("delta")
        ]
    );
    let grouped = run(&format!("{base}    groupBy: {{property: formula.v}}\n"));
    let counts: Vec<usize> = grouped
        .groups
        .as_ref()
        .unwrap()
        .iter()
        .map(|g| g.count)
        .collect();
    assert_eq!(counts, [1, 1, 1, 1]);
}

#[test]
fn a_limit_caps_the_listed_rows_not_the_summaries_or_the_total() {
    let r = run_with(
        "views:\n  - type: table\n    name: T\n    filters: price\n    order: [file.basename, price]\n    summaries: {price: Sum, file.basename: Count}\n",
        None,
        Some(2),
    )
    .unwrap();
    assert_eq!((r.total, r.shown), (3, 2));
    let sums: Vec<(String, Json)> = r
        .summaries
        .iter()
        .map(|s| (s.column.clone(), s.value.clone()))
        .collect();
    assert_eq!(
        sums,
        [
            ("file.basename".to_string(), json!(3)),
            ("price".to_string(), json!(60))
        ]
    );
}

#[test]
fn groups_keep_their_full_counts_and_say_when_rows_were_cut() {
    let r = run_with(
        "views:\n  - type: table\n    name: T\n    order: [file.basename, price]\n    groupBy: {property: type}\n    summaries: {price: Sum}\n",
        None,
        Some(3),
    )
    .unwrap();
    assert_eq!(r.shown, 3);
    let groups = r.groups.as_ref().unwrap();
    let shape: Vec<(Json, usize, usize, bool)> = groups
        .iter()
        .map(|g| (g.key.clone(), g.count, g.rows.len(), g.truncated))
        .collect();
    assert_eq!(
        shape,
        [
            (json!("Concept"), 2, 2, false),
            (json!("Project"), 2, 1, true)
        ]
    );
    assert_eq!(
        groups[1].summaries[0].value,
        json!(40),
        "summary covers the group's unlisted row too"
    );
    assert!(render_base_markdown(&r).contains("### Project (1 of 2 rows shown)"));

    let none = run_with(
        "views:\n  - type: table\n    name: T\n    order: [file.basename]\n    groupBy: {property: type}\n",
        None,
        Some(2),
    )
    .unwrap();
    let g = &none.groups.as_ref().unwrap()[1];
    assert_eq!((g.count, g.rows.len(), g.truncated), (2, 0, true));
    assert!(render_base_markdown(&none).contains("(no rows shown)"));
}

#[test]
fn columns_that_are_not_summarised_are_not_evaluated_for_unlisted_rows() {
    let r = run_with(
        "formulas:\n  bad: 'price.toFixed()'\nviews:\n  - type: table\n    name: T\n    filters: price\n    order: [file.basename, formula.bad]\n    summaries: {file.basename: Count}\n",
        None,
        Some(1),
    )
    .unwrap();
    assert_eq!(r.warnings, ["formula.bad: toFixed() needs a number"]);
    assert_eq!(r.summaries[0].value, json!(3));
}
