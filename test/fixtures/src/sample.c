/* Small test program for ReCode end-to-end tests. Contains arithmetic, struct and enum handling. */
#include <stdio.h>

enum shape_kind { SHAPE_RECT = 0, SHAPE_SQUARE = 1, SHAPE_TRIANGLE = 2 };

struct shape {
    enum shape_kind kind;
    int width;
    int height;
};

int add_ints(int a, int b) { return a + b; }

int multiply(int a, int b) { return a * b; }

int square(int value) { return multiply(value, value); }

int shape_area(const struct shape *s)
{
    switch (s->kind) {
    case SHAPE_RECT:
        return multiply(s->width, s->height);
    case SHAPE_SQUARE:
        return square(s->width);
    case SHAPE_TRIANGLE:
        return multiply(s->width, s->height) / 2;
    }
    return -1;
}

int sum_areas(const struct shape *shapes, int count)
{
    int total = 0;
    for (int i = 0; i < count; i++) {
        total = add_ints(total, shape_area(&shapes[i]));
    }
    return total;
}

int main(void)
{
    struct shape list[3] = { { SHAPE_RECT, 3, 4 }, { SHAPE_SQUARE, 5, 5 }, { SHAPE_TRIANGLE, 6, 4 } };
    printf("total area: %d\n", sum_areas(list, 3));
    return 0;
}
