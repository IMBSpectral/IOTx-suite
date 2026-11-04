//! Prints every engine command (id, label, menu, params) as JSON lines, to map the UI against.
//! `cargo run --release -p sheets-engine --example commands`

#![allow(clippy::disallowed_methods)]

fn main() {
    let mut s = imbgridly_engine::Session::new();
    s.new_workbook();
    for c in s.commands() {
        println!("{}", serde_json::to_string(&c).unwrap_or_default());
    }
}
