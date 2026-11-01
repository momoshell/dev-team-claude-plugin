# cargo test

## Test that can fail

Create an isolated scratch crate with `cargo new --lib arithmetic`, enter it,
and replace `src/lib.rs` with this subject and test. The expected literal is
independent of the implementation.

```rust
pub fn add(a: i32, b: i32) -> i32 { a + b }

#[cfg(test)]
mod tests {
    use super::add;
    // MUTATION: subtract instead of add.
    #[test]
    fn adds_numbers() { assert_eq!(add(2, 3), 5); }
}
```

## Run one test

```sh
cargo test tests::adds_numbers -- --exact
```

## Apply and revert a mutation

Run the command above in the scratch crate and observe green. Save the original
and change the subject from `a + b` to `a - b`:

```sh
cp src/lib.rs src/lib.rs.saved
python3 -c "from pathlib import Path; p=Path('src/lib.rs'); p.write_text(p.read_text().replace('a + b', 'a - b'))"
```

Run the same command and observe the named test red. Restore the saved copy
with `cp src/lib.rs.saved src/lib.rs`, then run again and observe green. Never
reset unrelated work; choose a scratch tree suited to the target.
