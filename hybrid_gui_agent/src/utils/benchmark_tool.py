import time

class BenchmarkTool:
    def __init__(self):
        # Dictionary structure: {phase_name: {"start": ns, "end": ns}}
        self.phases = {}

    def start_phase(self, name: str):
        """Record the start timestamp of a pipeline phase."""
        self.phases[name] = {
            "start": time.perf_counter_ns(),
            "end": None
        }

    def end_phase(self, name: str):
        """Record the end timestamp of a pipeline phase."""
        if name in self.phases:
            self.phases[name]["end"] = time.perf_counter_ns()
        else:
            # If start was not recorded, set current time as both start and end
            now = time.perf_counter_ns()
            self.phases[name] = {"start": now, "end": now}

    def get_metrics(self) -> dict:
        """Calculate durations in nanoseconds, microseconds, and milliseconds."""
        metrics = {}
        for name, times in self.phases.items():
            if times["start"] is not None and times["end"] is not None:
                duration_ns = times["end"] - times["start"]
                duration_us = duration_ns / 1000.0
                duration_ms = duration_us / 1000.0
                metrics[name] = {
                    "ns": duration_ns,
                    "us": duration_us,
                    "ms": duration_ms
                }
        return metrics

    def print_dashboard(self):
        """Prints a beautifully formatted ASCII dashboard table of processing metrics."""
        metrics = self.get_metrics()
        print("\n" + "=" * 62)
        print("                 HYBRID GUI AGENT LATENCY TELEMETRY")
        print("=" * 62)
        print(f"  {'Execution Phase':<25} | {'Duration (ms)':<15} | {'Duration (us)':<15}")
        print("-" * 62)
        
        total_ms = 0.0
        for name, data in metrics.items():
            if name == "Time-to-First-Token":
                # Skip printing here; printed as a sub-metric under VLM Decision
                continue
                
            print(f"  {name:<25} | {data['ms']:>12.3f} ms | {data['us']:>12.1f} us")
            total_ms += data["ms"]
            
            # Print TTFT immediately underneath VLM Decision if present
            if name == "VLM Decision" and "Time-to-First-Token" in metrics:
                ttft_data = metrics["Time-to-First-Token"]
                print(f"    └─ Time-to-First-Token   | {ttft_data['ms']:>12.3f} ms | {ttft_data['us']:>12.1f} us")
            
        print("-" * 62)
        print(f"  {'TOTAL PIPELINE LATENCY':<25} | {total_ms:>12.3f} ms | {total_ms*1000:>12.1f} us")
        print("=" * 62 + "\n")
