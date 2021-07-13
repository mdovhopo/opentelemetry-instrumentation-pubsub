import * as PubSub from '@google-cloud/pubsub';
import { Message, Subscription, Topic } from '@google-cloud/pubsub';
import { context, diag, propagation, Span, SpanKind, trace } from '@opentelemetry/api';
import {
  InstrumentationBase,
  InstrumentationConfig,
  InstrumentationNodeModuleDefinition,
  isWrapped,
  safeExecuteInTheMiddle,
} from '@opentelemetry/instrumentation';

const LIB = '@google-cloud/pubsub';

export class PubSubInstrumentation extends InstrumentationBase<typeof PubSub> {
  constructor(config: InstrumentationConfig = {}) {
    super('opentelemetry-instrumentation-pubsub', '1.1.0', { ...config });
  }

  private patch(moduleExports: typeof PubSub, version?: string): typeof PubSub {
    diag.debug(`Applying patch for ${LIB}@${version}`);
    // patch topic
    // topic.publish
    const topicProto = moduleExports.Topic.prototype;
    if (isWrapped(topicProto.publish)) {
      this._unwrap(topicProto, 'publish');
    }
    this._wrap(topicProto, 'publish', this.createTopicPublishPatch('publish'));

    if (isWrapped(topicProto.publishJSON)) {
      this._unwrap(topicProto, 'publishJSON');
    }
    this._wrap(topicProto, 'publishJSON', this.createTopicPublishPatch('publishJSON'));

    if (isWrapped(topicProto.publishMessage)) {
      this._unwrap(topicProto, 'publishMessage');
    }
    this._wrap(topicProto, 'publishMessage', this.createTopicPublishPatch('publishMessage'));

    const subscriptionProto = moduleExports.Subscription.prototype;

    if (isWrapped(subscriptionProto.on)) {
      this._unwrap(subscriptionProto, 'on');
    }
    this._wrap(subscriptionProto, 'on', this.createOnMessagePatch());

    return moduleExports;
  }

  private unpatch(moduleExports: typeof PubSub, version?: string): void {
    diag.debug(`Applying unpatch for ${LIB}@${version}`);
    if (moduleExports) {
      const topicProto = moduleExports.Topic.prototype;
      this._unwrap(topicProto, 'publish');
      this._unwrap(topicProto, 'publishJSON');
      this._unwrap(topicProto, 'publishMessage');

      const subscriptionProto = moduleExports.Subscription.prototype;
      this._unwrap(subscriptionProto, 'on');
    }
  }

  private createOnMessagePatch(): (original: Subscription['on']) => Subscription['on'] {
    const instr = this;
    return function (original: Subscription['on']) {
      return function onMessagePatch(this: Subscription, ...args: Parameters<typeof original>) {
        const [event, orgHandler] = args;
        let handler = orgHandler;

        if (event === 'message') {
          handler = (...args: unknown[]): unknown => {
            const msg = args[0] as Message;

            // extract trace context from attributes;
            const ctx = propagation.extract(context.active(), msg.attributes || {});
            const span = instr.tracer.startSpan(
              'subscription.message',
              {
                kind: SpanKind.CONSUMER,
                attributes: {
                  'topic.name': this.metadata?.topic || 'unknown',
                  'message.id': msg.id,
                },
              },
              ctx
            );

            const orgNack = msg.nack;
            msg.nack = () => {
              span.recordException('message was not acked');
              return orgNack.apply(msg);
            };

            return context.with(ctx, () =>
              safeExecuteInTheMiddle(
                () => orgHandler.apply(this, args),
                (err) => endSpan(span, err)
              )
            );
          };
        }

        return original.apply(this, [event, handler]);
      };
    };
  }

  private createTopicPublishPatch(
    method: 'publish'
  ): (original: Topic['publish']) => Topic['publish'];
  private createTopicPublishPatch(
    method: 'publishJSON'
  ): (original: Topic['publishJSON']) => Topic['publishJSON'];
  private createTopicPublishPatch(
    method: 'publishMessage'
  ): (original: Topic['publishMessage']) => Topic['publishMessage'];
  private createTopicPublishPatch(method: string): (original: any) => any {
    const instr = this;
    return function (original: any) {
      return function publishPatch(this: Topic, ...args: Parameters<typeof original>) {
        const attributes =
          method === 'publishMessage'
            ? (args[0] as Message).attributes || {}
            : args.length === 1
            ? {}
            : (args[args.length - 1] as PubSub.Attributes);

        const span = instr.tracer.startSpan(
          `topic.${method}`,
          {
            kind: SpanKind.PRODUCER,
          },
          context.active()
        );

        span.setAttributes(attributes);
        span.setAttribute('topic.name', this.name);

        const ctx = trace.setSpan(context.active(), span);
        propagation.inject(ctx, attributes);
        return context.with(ctx, () =>
          safeExecuteInTheMiddle(
            () => original.apply(this, args),
            (err) => endSpan(span, err)
          )
        );
      };
    };
  }

  protected init(): InstrumentationNodeModuleDefinition<typeof PubSub>[] {
    return [
      new InstrumentationNodeModuleDefinition<typeof PubSub>(
        LIB,
        ['^2.15.1'],
        (moduleExports, moduleVersion) => this.patch(moduleExports, moduleVersion),
        (moduleExports, moduleVersion) => this.unpatch(moduleExports, moduleVersion)
      ),
    ];
  }
}

function endSpan(span: Span, err?: Error) {
  err && span.recordException(err);
  span.end();
}
