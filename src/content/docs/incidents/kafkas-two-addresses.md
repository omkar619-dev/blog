---
title: 'Node may not be available: Kafka hands out its own address'
description: My Go producer wrote to Kafka happily while a consumer running inside the broker's own container couldn't connect to it at all. The broker was telling clients where to find it — and giving everyone the same answer, which only worked for half of them.
---

I'd just wired the gateway of my Go chat project to dual-write every message: to Redis for live delivery, and to a Kafka topic for durability. The producer ran without complaint. To verify messages were really landing in the log, I ran the console consumer inside the Kafka container:

```text
$ docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
    --bootstrap-server localhost:9092 --topic chat.messages --from-beginning

WARN Connection to node 1 (localhost/127.0.0.1:9094) could not be established.
     Node may not be available. (org.apache.kafka.clients.NetworkClient)
WARN Connection to node 1 (localhost/127.0.0.1:9094) could not be established.
... forever
```

Two things about that message are odd, and both matter.

**First: it never errors out, it just warns forever.** Kafka clients treat an unreachable broker as a transient condition and retry indefinitely. So there's no stack trace and no exit code — just a wall of identical warnings.

**Second, and this is the actual clue: I connected to `9092` and it's talking about `9094`.**

## The broker tells you where to call it back

When a Kafka client connects, the address it dialled is only a **bootstrap** address. The broker immediately responds with metadata that includes the address clients should use for real work — its **advertised listener**. Every subsequent connection goes there, not to the address you originally typed.

You ring the main switchboard, and the receptionist says *"call me back on my direct line."* Everything after that goes to the direct line.

My compose file said:

```text
KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093
KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9094
ports:
  - "9094:9092"
```

The broker listens on `9092` inside the container, Docker maps host `9094` to it, and the broker advertises **`localhost:9094`**.

For my Go producer, running on the host, that's correct — `localhost:9094` is exactly right, which is why the producer worked perfectly the whole time.

For the console consumer, running **inside the container**, it's nonsense. Inside that container `localhost` is the container itself, and nothing is listening there on `9094` — the container's own port is `9092`. So it bootstrapped successfully on `9092`, was told to call back on `9094`, and dialled a number that only works from outside the building.

**The producer was never broken. Only the verification tool was.** Which is a slightly worse failure mode, because for a few minutes I believed my durability layer was broken when it was the thing I'd chosen to check it with.

## The fix: two listeners, two answers

The broker can advertise a different address per listener. Clients get the one that's reachable from where they are:

```text
KAFKA_LISTENERS: INTERNAL://:9092,CONTROLLER://:9093,EXTERNAL://:9094
KAFKA_ADVERTISED_LISTENERS: INTERNAL://kafka:9092,EXTERNAL://localhost:9094
KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
KAFKA_INTER_BROKER_LISTENER_NAME: INTERNAL
KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,INTERNAL:PLAINTEXT,EXTERNAL:PLAINTEXT
ports:
  - "9094:9094"
```

Two call-back numbers:

- **INTERNAL** advertises `kafka:9092` — the Docker service name, resolvable inside the network. For anything running in a container.
- **EXTERNAL** advertises `localhost:9094` — for clients on the host.

A few details that are easy to get wrong: the port mapping becomes `9094:9094` because the broker now genuinely listens on 9094 for external clients rather than having it mapped onto 9092; every listener name needs an entry in `LISTENER_SECURITY_PROTOCOL_MAP`; and `INTER_BROKER_LISTENER_NAME` has to name one of them so brokers know which address to use among themselves.

Then the consumer works — connecting via the *internal* address:

```text
$ docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
    --bootstrap-server kafka:9092 --topic chat.messages --from-beginning
{"username":"omkar","body":"lessgoo kafka is there which we have configured!!"}
```

## A second red herring, self-inflicted

One message came back. I'd sent two.

Changing listener config means clearing Kafka's stored metadata, so the fix included `docker volume rm chat-go_kafka_data`. Message one had been written to the log **before** that wipe. Message two arrived after. The browser still showed both because the browser had never lost them — those were live-delivered over Redis and sat in the DOM, entirely independent of what was on disk.

That accident is a decent illustration of what the dual-write architecture actually does. The same message lives in three places with three different lifespans:

| Where | Lifespan |
|---|---|
| Browser DOM | until you refresh |
| Redis pub/sub | gone the instant it's delivered — only current subscribers hear it |
| Kafka log | on disk, replayable |

Seeing them disagree was the clearest demonstration I could have staged deliberately.

## Lessons

1. **`--bootstrap-server` is where you start, not where you end up.** If a Kafka client hangs while the port is clearly open, read the address in the *warning*, not the one you typed. When they differ, you're looking at `advertised.listeners`.
2. **An address that works from the host is not an address, it's a point of view.** `localhost` means something different inside a container. Any config value containing `localhost` in a containerised system deserves the question "localhost according to whom?"
3. **Endless WARN with no ERROR is a real failure mode.** Kafka clients retry forever by design. Nothing crashes, nothing exits non-zero — a health check watching for process death would call this healthy.
4. **Suspect your verification tool, not just the thing being verified.** My producer was fine. I spent the debugging time inside the wrong component because the tool I chose to build confidence had a different network view than the code I was testing.
