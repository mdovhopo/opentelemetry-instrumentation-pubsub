import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { B3InjectEncoding, B3Propagator } from '@opentelemetry/propagator-b3';
import { ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { PubSubInstrumentation } from '../src/instrumentation';

export function setupTracing(): void {
  const provider = new NodeTracerProvider();
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [new PubSubInstrumentation()],
  });

  provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));

  // Initialize the OpenTelemetry APIs to use the NodeTracerProvider bindings
  provider.register({
    propagator: new B3Propagator({
      // propagate tracing info via 'b3' attribute
      injectEncoding: B3InjectEncoding.SINGLE_HEADER,
    }),
  });
}
