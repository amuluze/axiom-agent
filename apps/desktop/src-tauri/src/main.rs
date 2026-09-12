fn main() {
    if let Err(error) = axiom_lib::run() {
        eprintln!("Axiom failed to start: {error}");
        std::process::exit(1);
    }
}
