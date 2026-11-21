package com.cinevault.app.ui;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.cinevault.app.R;
import com.cinevault.app.data.Models;

import java.util.ArrayList;
import java.util.List;

/**
 * Adapter rendering recents-first Home category carousel sections.
 */
public final class HomeSectionAdapter extends RecyclerView.Adapter<HomeSectionAdapter.VH> {
    public interface OnSeeAll { void onSeeAll(Models.HomeSection section); }

    private final List<Models.HomeSection> sections = new ArrayList<>();
    private final MediaCardAdapter.OnItemClick onItemClick;
    private final OnSeeAll onSeeAll;

    public HomeSectionAdapter(MediaCardAdapter.OnItemClick onItemClick, OnSeeAll onSeeAll) {
        this.onItemClick = onItemClick;
        this.onSeeAll = onSeeAll;
    }

    public void submitList(List<Models.HomeSection> list) {
        sections.clear();
        if (list != null) sections.addAll(list);
        notifyDataSetChanged();
    }

    @NonNull
    @Override
    public VH onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View v = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_home_section, parent, false);
        return new VH(v);
    }

    @Override
    public void onBindViewHolder(@NonNull VH h, int position) {
        Models.HomeSection sec = sections.get(position);
        h.title.setText(sec.title);
        h.subtitle.setText(sec.subtitle);
        h.seeAll.setOnClickListener(v -> {
            if (onSeeAll != null) onSeeAll.onSeeAll(sec);
        });
        h.adapter.submitList(sec.items);
    }

    @Override
    public int getItemCount() { return sections.size(); }

    final class VH extends RecyclerView.ViewHolder {
        final TextView title;
        final TextView subtitle;
        final TextView seeAll;
        final MediaCardAdapter adapter;

        VH(@NonNull View v) {
            super(v);
            title = v.findViewById(R.id.section_title);
            subtitle = v.findViewById(R.id.section_subtitle);
            seeAll = v.findViewById(R.id.btn_see_all);
            boolean tv = UiHelper.isAndroidTv(v.getContext());
            boolean tablet = UiHelper.isTablet(v.getContext());
            if (tv || tablet) {
                title.setTextSize(tv ? 20f : 18.5f);
                subtitle.setTextSize(tv ? 13.5f : 12.5f);
                seeAll.setTextSize(tv ? 14f : 13f);
                int hPad = UiHelper.dp(v.getContext(), tv ? 28 : 22);
                View headerRow = (View) title.getParent().getParent();
                if (headerRow != null) {
                    headerRow.setPadding(hPad, headerRow.getPaddingTop(), hPad, headerRow.getPaddingBottom());
                }
            }
            UiHelper.applyTvFocusEffect(seeAll, 1.06f);
            RecyclerView rv = v.findViewById(R.id.section_items_recycler);
            if (tv || tablet) {
                int rPad = UiHelper.dp(v.getContext(), tv ? 24 : 18);
                rv.setPadding(rPad, rv.getPaddingTop(), rPad, rv.getPaddingBottom());
            }
            rv.setLayoutManager(new LinearLayoutManager(v.getContext(), LinearLayoutManager.HORIZONTAL, false));
            adapter = new MediaCardAdapter(false, false, onItemClick, null);
            rv.setAdapter(adapter);
        }
    }
}
