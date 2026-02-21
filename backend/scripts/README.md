# Hướng dẫn chạy script merge dữ liệu

## Yêu cầu

```bash
pip install rasterio numpy
```

## Chạy script merge

```bash
cd c:\Users\ttung05\Desktop\DAP
python scripts\merge_data.py
```

Script sẽ:
1. Đọc tất cả file .tif từ FloodData
2. Merge theo ngày
3. Downsample để giảm kích thước
4. Lưu vào `data/MergedDatabase/`

## Test dữ liệu

```bash
python scripts\test_merge.py DBSCL 20
```

## Lưu ý

- Quá trình merge có thể mất 4-6 giờ
- Kích thước database ước tính: 5-10GB
- Cần đủ dung lượng ổ đĩa
