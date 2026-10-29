package dev.apphx.runtime;

import android.app.Activity;
import android.os.Bundle;
import android.content.SharedPreferences;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

public final class MainActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        SharedPreferences records = getSharedPreferences("records", MODE_PRIVATE);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(32, 64, 32, 32);
        TextView title = new TextView(this);
        title.setText("Local record notebook");
        title.setTextSize(24);
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint("Record text");
        input.setContentDescription("Record text");
        TextView saved = new TextView(this);
        saved.setTextSize(22);
        saved.setText(records.getString("record", "No saved record"));
        saved.setContentDescription("Saved record");
        Button save = new Button(this);
        save.setText("Save record");
        save.setContentDescription("Save record");
        save.setOnClickListener(view -> {
            String value = input.getText().toString().trim();
            if (value.isEmpty()) { input.setError("Enter a record"); return; }
            if (!records.edit().putString("record", value).commit()) {
                input.setError("Could not save record"); return;
            }
            saved.setText(value);
            input.setText("");
        });
        layout.addView(title); layout.addView(input); layout.addView(save); layout.addView(saved);
        setContentView(layout);
    }
}
