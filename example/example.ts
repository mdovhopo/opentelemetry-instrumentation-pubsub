import { setupTracing } from './setup-tracing';

setupTracing();

import { PubSub } from '@google-cloud/pubsub';
import { credentials } from '@grpc/grpc-js';
import { context, trace } from '@opentelemetry/api';
import { wait } from 'better-wait';

const pid = 'stub';
const tid = 'topic_stub';
const sid = 'sub_stub';

async function main() {
  console.log('creating pubsub instance...');
  const ps = new PubSub({
    projectId: pid,
    servicePath: 'localhost',
    port: '8888',
    sslCreds: credentials.createInsecure(),
  });

  console.log('creating topic...');
  let topic = ps.topic(tid);
  const [topicExists] = await topic.exists();
  if (!topicExists) {
    [topic] = await ps.createTopic(tid);
  }
  const data = { data: 'test' };
  // create one single trace for all example calls
  const ctx = trace.setSpan(context.active(), trace.getTracer('default').startSpan('test'));
  console.log('sending messages...');
  await context.with(ctx, async () => {
    // topic.publish
    // no attributes
    await topic.publish(Buffer.from(JSON.stringify(data)));
    // with attributes
    await topic.publish(Buffer.from(JSON.stringify(data)), { Operation: 'test' });

    // topic.publishJSON
    // no attributes
    await topic.publishJSON(data);
    // with attributes
    await topic.publishJSON(data, { Operation: 'test' });

    // topic.publishMessage
    // no attributes
    await topic.publishMessage({ data: Buffer.from(JSON.stringify(data)) });
    // with attributes
    await topic.publishMessage({
      data: Buffer.from(JSON.stringify(data)),
      attributes: { Operation: 'test' },
    });
  });

  console.log('subscribe to topic...');
  let sub = ps.subscription(sid);
  const [subExists] = await sub.exists();
  if (!subExists) {
    [sub] = await ps.createSubscription(tid, sid);
  }

  console.log('listen for messages...');
  sub.on('message', (msg) => {
    console.log('received message #', msg.id);
    console.log('attributes', msg.attributes);
    console.log('data', Buffer.from(msg.data).toString());
    msg.ack();
  });

  console.log('traces will be printed to the console...');
  // delay, to let exporter to flash spans
  wait('20s').then(() => process.exit());
}

main().catch(console.log);
