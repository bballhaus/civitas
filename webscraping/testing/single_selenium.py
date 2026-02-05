"""
Test script that scrapes one event and saves it to CSV
"""

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
import csv
import time

TEST_URL = 'https://caleprocure.ca.gov/event/3540/35409TSC01'
OUTPUT_FILE = 'test_event.csv'

def test_selenium_scrape():
    print(f"Testing Selenium scrape on: {TEST_URL}")
    print("=" * 80)
    
    # Set up Chrome
    options = webdriver.ChromeOptions()
    # Run with browser visible so you can see what's happening
    # options.add_argument('--headless')  # Uncomment to hide browser
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)
    wait = WebDriverWait(driver, 15)
    
    try:
        # Load the page
        print("\n1. Loading page...")
        driver.get(TEST_URL)
        
        # Wait for JavaScript to load data
        print("2. Waiting for JavaScript to populate data...")
        wait.until(
            EC.presence_of_element_located((By.CSS_SELECTOR, '[data-if-label="eventName"]'))
        )
        
        # Give extra time for all data to load
        time.sleep(3)
        
        print("\n3. Extracting data...")
        print("-" * 80)
        
        # Create dictionary to store event data
        event_data = {
            'event_url': TEST_URL,
            'event_id': '',
            'title': '',
            'description': '',
            'contact_name': '',
            'contact_email': '',
            'contact_phone': '',
            'department': '',
            'start_date': '',
            'end_date': '',
            'format': ''
        }
        
        # Extract event ID from URL
        parts = TEST_URL.split('/')
        if len(parts) >= 4:
            event_data['event_id'] = f"{parts[-2]}/{parts[-1]}"
        
        # Extract title
        try:
            title_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventName"]')
            title = title_elem.text.strip()
            if title and title != '[Event Title]':
                event_data['title'] = title
                print(f"✓ Title: {title}")
        except:
            print("✗ Title: NOT FOUND")
        
        # Extract description
        try:
            desc_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="descriptiondetails"]')
            desc = desc_elem.text.strip()
            if desc and desc != '[Detail Description]':
                event_data['description'] = desc
                print(f"✓ Description: {desc[:100]}...")
        except:
            print("✗ Description: NOT FOUND")
        
        # Extract contact name
        try:
            contact_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="contactName"]')
            contact = contact_elem.text.strip()
            if contact and contact != '[Contact Name]':
                event_data['contact_name'] = contact
                print(f"✓ Contact Name: {contact}")
        except:
            print("✗ Contact Name: NOT FOUND")
        
        # Extract email
        try:
            email_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="emailAnchor"]')
            email = email_elem.text.strip()
            if email and email != '[EmailAddress]':
                event_data['contact_email'] = email
                print(f"✓ Email: {email}")
        except:
            try:
                email_elem = driver.find_element(By.ID, 'RESP_INQ_DL0_WK_EMAILID')
                email = email_elem.text.strip()
                if email:
                    event_data['contact_email'] = email
                    print(f"✓ Email (alternate): {email}")
            except:
                print("✗ Email: NOT FOUND")
        
        # Extract phone
        try:
            phone_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="phoneText"]')
            phone = phone_elem.text.strip()
            if phone and phone != '[Phone Number]':
                event_data['contact_phone'] = phone
                print(f"✓ Phone: {phone}")
        except:
            print("✗ Phone: NOT FOUND")
        
        # Extract department
        try:
            dept_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="dept"]')
            dept = dept_elem.text.strip()
            if dept:
                event_data['department'] = dept
                print(f"✓ Department: {dept}")
        except:
            print("✗ Department: NOT FOUND")
        
        # Extract start date
        try:
            start_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventStartDate"]')
            start_date = start_elem.text.strip()
            if start_date:
                event_data['start_date'] = start_date
                print(f"✓ Start Date: {start_date}")
        except:
            print("✗ Start Date: NOT FOUND")
        
        # Extract end date
        try:
            end_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventEndDate"]')
            end_date = end_elem.text.strip()
            if end_date:
                event_data['end_date'] = end_date
                print(f"✓ End Date: {end_date}")
        except:
            print("✗ End Date: NOT FOUND")
        
        # Extract format
        try:
            format1_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="format1"]')
            format2_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="format2"]')
            format1 = format1_elem.text.strip()
            format2 = format2_elem.text.strip()
            if format1 or format2:
                event_data['format'] = f"{format1} / {format2}".strip(' /')
                print(f"✓ Format: {event_data['format']}")
        except:
            print("✗ Format: NOT FOUND")
        
        print("-" * 80)
        
        # Write to CSV
        print(f"\n4. Writing data to {OUTPUT_FILE}...")
        
        with open(OUTPUT_FILE, mode='w', newline='', encoding='utf-8') as csv_file:
            fieldnames = [
                'event_id', 'event_url', 'title', 'description',
                'department', 'format', 'start_date', 'end_date',
                'contact_name', 'contact_email', 'contact_phone'
            ]
            
            writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerow(event_data)
        
        print(f"✓ Successfully saved to {OUTPUT_FILE}")
        print("\n" + "=" * 80)
        print("Test complete!")
        print(f"Check {OUTPUT_FILE} for the scraped data.")
        print("\nPress Enter to close browser...")
        
        # Keep browser open so you can inspect
        input()
        
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
    
    finally:
        driver.quit()
        print("\nBrowser closed.")


if __name__ == '__main__':
    test_selenium_scrape()
