# A Bursar skill for OpenClaw

An [OpenClaw](https://openclaw.ai) agent spends from a Bursar mandate: a budget on Robinhood Chain
with a per-call cap, a daily cap and a list of what it may pay for, set by the mandate's owner. The
skill is the folder `bursar/`: a `SKILL.md` that tells the agent how to quote, pay, trade and read
its endowment through Bursar's hosted MCP server, and how to answer when someone asks it to
overspend. The limits are the chain's, so the answer is a refusal either way.

## Setup

1. On the mandate page in the Bursar console, open **Connectors** and create a connection. Copy
   the token; it is shown once.
2. Register the server, with the token in the environment rather than on the command line:

   ```sh
   export BURSAR_MCP_TOKEN=...
   openclaw mcp set bursar '{"url":"https://mcp.bursar.world/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer ${BURSAR_MCP_TOKEN}"}}'
   openclaw mcp probe bursar
   ```

3. Install the skill:

   ```sh
   openclaw skills install @bursar/bursar
   ```

   or, from this folder, `openclaw skills install ./bursar --as bursar`.

Then ask the agent to pay for something:

```sh
openclaw agent --local -m "Use the bursar skill. Pay 0x5210…a374 twenty-five cents for gpu.render:1, deliver within a day, input {\"prompt\":\"a koi, ink on paper\"}."
```

The agent quotes, pays, and reports the settlement and its transaction. Asked to pay fifty dollars
on a fifty-cent cap, it declines and offers what the mandate allows; sent anyway, the chain refuses
it.
