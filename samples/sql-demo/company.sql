-- DEMO-SQL sample database (fictional)
CREATE TABLE departments (dept_id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE employees (emp_id INTEGER PRIMARY KEY, name TEXT NOT NULL, dept_id INTEGER REFERENCES departments(dept_id), salary INTEGER NOT NULL, manager_id INTEGER REFERENCES employees(emp_id));
INSERT INTO departments VALUES (1, 'Research'), (2, 'Sales'), (3, 'Legal');
INSERT INTO employees VALUES
 (1, 'Alice', 1, 9000, NULL),
 (2, 'Bob',   1, 7000, 1),
 (3, 'Chen',  2, 6000, 1),
 (4, 'Dana',  2, 6500, 3),
 (5, 'Eve',   NULL, 5000, 3);
