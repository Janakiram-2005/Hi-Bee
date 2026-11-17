#!/usr/bin/env python3
"""
Wrapper script providing backward compatibility for train_model.py by delegating
to train_word_model.py.
"""
import os
import sys

script_dir = os.path.dirname(os.path.abspath(__file__))
target_script = os.path.join(script_dir, "train_word_model.py")

if __name__ == '__main__':
    if os.path.exists(target_script):
        import runpy
        runpy.run_path(target_script, run_name='__main__')
    else:
        print(f"Error: target training script {target_script} not found.", file=sys.stderr)
        sys.exit(1)
