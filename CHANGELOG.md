# Changelog

## 0.3.0-alpha.1

- initial public release of `pi-cc-bridge`
- Claude runs as the model engine while Pi remains the tool executor
- same-process follow-ups reuse the live Claude session when possible
- fresh-process Pi resume uses replayed Pi context instead of brittle fabricated Claude resume IDs
- includes logging and diagnostics for bridge and pipe recovery
