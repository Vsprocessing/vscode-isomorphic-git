/*---------------------------------------------------------------------------------------------
 *  No-op telemetry reporter: the web build does not send telemetry.
 *--------------------------------------------------------------------------------------------*/

export class TelemetryReporter {
	sendTelemetryEvent(_eventName: string, _properties?: Record<string, string>, _measurements?: Record<string, number>): void { }
	sendTelemetryErrorEvent(_eventName: string, _properties?: Record<string, string>, _measurements?: Record<string, number>): void { }
	dispose(): Promise<void> {
		return Promise.resolve();
	}
}
export default TelemetryReporter;
